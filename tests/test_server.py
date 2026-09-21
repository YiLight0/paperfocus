import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import fitz
from server import extract_pdf, score_payload
from document import plan_batches, within_budget
from settings import load_env
from unittest.mock import patch, Mock
import os, tempfile

def fixture(rotation=0):
    d=fitz.open();p=d.new_page();p.insert_text((60,90),'We compared three methods. The baseline was fixed.');p.set_rotation(rotation)
    data=d.tobytes();d.close();return data

class PaperTests(unittest.TestCase):
    def test_key_reloads_without_restart(self):
        import server
        with patch.object(server, 'KEY', ''), patch.object(server, 'PROCESS_KEY', ''), patch.object(server, 'read_env', side_effect=[{}, {'TYPESAFE_API_KEY':'test-new-key'}]):
            self.assertEqual(server.current_key(), '')
            self.assertEqual(server.current_key(), 'test-new-key')


    def test_source_mapping(self):
        doc=extract_pdf(fixture())
        self.assertEqual(len(doc['sentences']),2)
        self.assertEqual(doc['sentences'][0]['text'],'We compared three methods.')
        self.assertEqual(doc['sentences'][1]['page'],1)
        for s in doc['sentences']:
            for x,y,w,h in s['rects']:
                self.assertTrue(0<=x<x+w<=1 and 0<=y<y+h<=1)
    def test_rotation(self):
        a=extract_pdf(fixture());b=extract_pdf(fixture(90))
        self.assertEqual(a['pages'][0]['width'],b['pages'][0]['height'])
        self.assertNotEqual(a['sentences'][0]['rects'],b['sentences'][0]['rects'])
        for x,y,w,h in b['sentences'][0]['rects']:
            self.assertTrue(0<=x<x+w<=1 and 0<=y<y+h<=1)
    def test_payload_ids_and_rubric(self):
        doc=extract_pdf(fixture());p=score_payload(doc,'How was the experiment designed?',['s00000'])
        self.assertEqual(p['questions']['s00000']['type'],'score')
        self.assertEqual(len(p['questions']['s00000']['criteria']),4)
        self.assertIn('s00000',p['questions']['s00000']['instructions'])
        self.assertIn('The baseline was fixed.',p['state']['paragraphs']['p00000']['text'])
        self.assertEqual(p['state']['sentences']['s00000']['paragraphId'],'p00000')
    def test_invalid_ids(self):
        doc=extract_pdf(fixture())
        for ids in ([],['unknown'],['s00000','s00000']):
            with self.assertRaises(ValueError):score_payload(doc,'q',ids)
    def test_scan_rejected(self):
        d=fitz.open();d.new_page()
        with self.assertRaises(ValueError):extract_pdf(d.tobytes())
        d.close()

    def test_batch_preserves_paragraph_and_exceeds_sixteen(self):
        doc=extract_pdf(fixture())
        doc['sentences']=[dict(doc['sentences'][0],id=f's{i:05}',text=f'Sentence {i} provides experimental details.') for i in range(35)]
        doc['paragraphs'][0]['sentenceIds']=[s['id'] for s in doc['sentences']]
        doc['paragraphs'][0]['text']=' '.join(s['text'] for s in doc['sentences'])
        batches=plan_batches(doc,'How was the experiment designed?')
        self.assertEqual(len(batches),1)
        self.assertEqual(len(batches[0]),36)
        self.assertTrue(within_budget(score_payload(doc,'question',batches[0])))

    def test_large_paragraph_splits_targets_not_context(self):
        doc=extract_pdf(fixture()); template=doc['sentences'][0]
        doc['sentences']=[dict(template,id=f's{i:05}',text=f'Sentence {i}.') for i in range(130)]
        p=doc['paragraphs'][0];p['sentenceIds']=[s['id'] for s in doc['sentences']];p['text']=' '.join(s['text'] for s in doc['sentences'])
        batches=plan_batches(doc,'question');flat=[i for b in batches for i in b]
        self.assertGreater(len(batches),1)
        self.assertEqual(len(flat),len(set(flat)))
        self.assertEqual(set(flat),{p['id'],*p['sentenceIds']})
        for b in batches:
            payload=score_payload(doc,'question',b)
            self.assertTrue(within_budget(payload))
            self.assertEqual(payload['state']['paragraphs'][p['id']]['text'],p['text'])

    def test_figure_caption_geometry(self):
        d=fitz.open();p=d.new_page()
        p.draw_rect(fitz.Rect(60,100,300,230),color=(0,0,0),fill=(.8,.9,.9))
        p.insert_text((60,250),'Figure 1. Experimental setup and baseline conditions.',fontsize=10)
        result=extract_pdf(d.tobytes());d.close()
        self.assertEqual(len(result['figures']),1)
        figure=result['figures'][0]
        self.assertEqual(result['paragraphs'][0]['id'],figure['captionId'])
        self.assertGreater(figure['groupRect'][3],figure['rects'][0][3])
        self.assertEqual(figure['basis'],'caption')

    def test_no_graphic_does_not_invent_figure_box(self):
        d=fitz.open();p=d.new_page();p.insert_text((60,250),'Figure 1. A caption without detectable graphics.')
        self.assertEqual(extract_pdf(d.tobytes())['figures'],[]);d.close()

    def test_reference_section_is_skipped_unless_requested(self):
        d=fitz.open();p=d.new_page();p.insert_text((60,80),'Main contribution. We introduce a precise reading method.')
        p.insert_text((60,140),'References');p.insert_text((60,170),'[1] Smith, J. A related paper. 2024.')
        doc=extract_pdf(d.tobytes());d.close()
        reference_ids={i for p in doc['paragraphs'] if p['kind']=='references' for i in [p['id'],*p['sentenceIds']]}
        normal={i for batch in plan_batches(doc,'What is the core contribution?') for i in batch}
        requested={i for batch in plan_batches(doc,'Which references are cited?') for i in batch}
        self.assertTrue(reference_ids)
        self.assertTrue(reference_ids.isdisjoint(normal))
        self.assertTrue(reference_ids.issubset(requested))

    def test_two_stage_plans_only_requested_units(self):
        doc=extract_pdf(fixture());selected=[p['id'] for p in doc['paragraphs'] if p['kind'] in {'paragraph','caption'}][:2]
        paragraph_ids={i for batch in plan_batches(doc,'question','paragraphs') for i in batch}
        sentence_ids={i for batch in plan_batches(doc,'question','sentences',selected) for i in batch}
        self.assertTrue(paragraph_ids)
        self.assertTrue(all(i.startswith('p') for i in paragraph_ids))
        self.assertTrue(sentence_ids)
        self.assertTrue(all(i.startswith('s') for i in sentence_ids))
        self.assertEqual(sentence_ids,{i for p in doc['paragraphs'] if p['id'] in selected for i in p['sentenceIds']})

    def test_env_quotes_and_precedence(self):
        with patch.dict(os.environ,{'TYPESAFE_MODEL':'existing'},clear=True):
            path=Mock();path.exists.return_value=True;path.read_text.return_value='# comment\nTYPESAFE_API_KEY="test-value"\nTYPESAFE_MODEL=other\nUNRELATED=no\n'
            load_env(path)
            self.assertEqual(os.environ['TYPESAFE_API_KEY'],'test-value')
            self.assertEqual(os.environ['TYPESAFE_MODEL'],'existing')
            self.assertNotIn('UNRELATED',os.environ)

if __name__=='__main__':unittest.main()
