"""Local-only PDF reading prototype. Model judgments use TypeSafe Jev only."""
import json, os, re, time, uuid, threading, urllib.request, urllib.error, socket, ssl
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import fitz
from document import extract_pdf, score_payload, plan_batches, within_budget
from settings import load_env, read_env

ROOT = Path(__file__).resolve().parent
DOCS = {}
LOCK = threading.Lock()
PROCESS_KEY = os.environ.get('TYPESAFE_API_KEY', '').strip()
load_env(ROOT / '.env')
KEY = ''  # Optional temporary override entered in the browser.
MODEL = os.environ.get('TYPESAFE_MODEL', 'jev-latest')
PORT = int(os.environ.get('PORT', '8765'))
MAX_PDF = int(os.environ.get('MAX_PDF_MB', '200')) * 1024 * 1024

def current_key():
    return KEY or PROCESS_KEY or read_env(ROOT / '.env').get('TYPESAFE_API_KEY', '').strip()

def typesafe_opener():
    """Use an explicit proxy, and recover from Codex's local deny proxy on Windows."""
    configured = read_env(ROOT / '.env').get('TYPESAFE_PROXY', '').strip()
    proxy = configured or os.environ.get('HTTPS_PROXY', '') or os.environ.get('https_proxy', '')
    if os.name == 'nt' and proxy.rstrip('/').endswith('127.0.0.1:9'):
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Internet Settings') as key:
                enabled = winreg.QueryValueEx(key, 'ProxyEnable')[0]
                value = winreg.QueryValueEx(key, 'ProxyServer')[0] if enabled else ''
            if value:
                if '=' in value:
                    parts = dict(p.split('=', 1) for p in value.split(';') if '=' in p)
                    value = parts.get('https') or parts.get('http') or ''
                proxy = value if '://' in value else f'http://{value}'
        except (OSError, ValueError):
            pass
    return urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy, 'https': proxy})) if proxy else urllib.request.build_opener()

def call_jev(payload, key):
    req = urllib.request.Request('https://api.typesafe.ai/v1/systemone', data=json.dumps(payload).encode(), headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method='POST')
    try:
        with typesafe_opener().open(req, timeout=60) as res: return json.load(res)
    except urllib.error.HTTPError as exc:
        messages = {401:'API key 无效或已失效。',403:'账户没有访问权限，请检查 TypeSafe 控制台。',422:'请求格式或模型名称无效。',429:'达到 API 限流，请稍后重新提问。',529:'Jev 当前负载较高，请稍后重试。',402:'账户额度不足，请检查 TypeSafe 控制台。'}
        raise ValueError(messages.get(exc.code, f'Jev 返回 HTTP {exc.code}，请稍后重试。')) from None
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, (socket.timeout, TimeoutError)): message='连接 Jev 超时；请检查代理是否运行，或稍后重试。'
        elif isinstance(reason, ConnectionRefusedError): message='Jev 请求被代理拒绝；请检查本机代理是否运行。'
        elif isinstance(reason, ssl.SSLError): message='连接 Jev 时 TLS 验证失败；请检查系统时间或代理证书。'
        elif isinstance(reason, socket.gaierror): message='无法解析 api.typesafe.ai；请检查 DNS 或代理设置。'
        else: message=f'无法连接 Jev：{str(reason)[:180]}'
        raise ValueError(message) from None
    except (socket.timeout, TimeoutError): raise ValueError('读取 Jev 响应超时，请稍后重试。') from None

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def send(self, status, body, mime='application/json'):
        raw = json.dumps(body, ensure_ascii=False).encode() if mime=='application/json' else body
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length',str(len(raw)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.end_headers()
        try: self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError): pass
    def valid_host(self):
        return self.headers.get('Host') in {f'127.0.0.1:{PORT}',f'localhost:{PORT}'}
    def get_doc(self, did):
        with LOCK:
            doc = DOCS.get(did)
            if not doc: raise ValueError('文档会话已过期，请重新上传。')
            return doc
    def do_GET(self):
        if not self.valid_host(): return self.send(403, {'error':'不允许的主机。'})
        path = self.path.split('?')[0]
        if path == '/api/status': return self.send(200, {'configured':bool(current_key()),'model':MODEL,'maxPdfBytes':MAX_PDF})
        if path.startswith('/api/page/'):
            try:
                _,_,_,did,p = path.split('/')
                doc = self.get_doc(did)
                with fitz.open(stream=doc['data'], filetype='pdf') as pdf:
                    page = pdf[int(p)-1]
                    pix = page.get_pixmap(matrix=fitz.Matrix(1.6,1.6), alpha=False)
                    return self.send(200,pix.tobytes('png'),'image/png')
            except Exception: return self.send(400, {'error':'无法渲染该页，请重新上传。'})
        files = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'}
        if path in files:
            name=files[path]; mime={'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8'}[name.split('.')[-1]]
            return self.send(200,(ROOT/name).read_bytes(),mime)
        self.send(404,{'error':'未找到。'})
    def do_POST(self):
        global KEY
        if not self.valid_host() or self.headers.get('Origin') not in {f'http://127.0.0.1:{PORT}',f'http://localhost:{PORT}'}:
            return self.send(403,{'error':'仅允许本机页面调用。'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            limit=MAX_PDF if self.path=='/api/upload' else 100000
            if not 0 < length <= limit: return self.send(413,{'error':f'上传为空或超过大小限制（当前 PDF 上限 {MAX_PDF//1024//1024} MB，可通过 MAX_PDF_MB 调整）。'})
            raw=self.rfile.read(length)
            if self.path=='/api/upload':
                if not raw.startswith(b'%PDF-'): raise ValueError('请选择有效的 PDF 文件。')
                result=extract_pdf(raw); did=uuid.uuid4().hex
                with LOCK:
                    for old in list(DOCS):
                        if time.time()-DOCS[old]['created']>7200: del DOCS[old]
                    if len(DOCS)>=3: del DOCS[next(iter(DOCS))]
                    DOCS[did]={**result,'data':raw,'created':time.time()}
                return self.send(200,{**result,'id':did})
            body=json.loads(raw)
            if self.path=='/api/key':
                key=body.get('key','')
                if not isinstance(key,str) or not 8<=len(key.strip())<=1000: raise ValueError('请填入有效格式的 API key。')
                KEY=key.strip()
                return self.send(200,{'configured':True})
            if self.path=='/api/plan':
                question=body.get('question','')
                if not isinstance(question,str) or not 1<=len(question.strip())<=500: raise ValueError('问题应为 1–500 个字符。')
                doc=self.get_doc(body.get('docId'))
                return self.send(200,{'batches':plan_batches(doc,question.strip(),body.get('mode','all'),body.get('paragraphIds'))})
            if self.path=='/api/score':
                key=current_key()
                if not key: return self.send(428,{'error':'请先配置 TypeSafe API key。'})
                question=body.get('question','')
                if not isinstance(question,str) or not 1<=len(question.strip())<=500: raise ValueError('问题应为 1–500 个字符。')
                doc=self.get_doc(body.get('docId'))
                ids=body.get('ids')
                if isinstance(ids,list) and all(isinstance(i,str) for i in ids): ids=list(dict.fromkeys(ids))
                payload=score_payload(doc,question.strip(),ids)
                payload['model']=MODEL
                if not within_budget(payload): raise ValueError('该批内容超出请求预算，请重新提问。')
                started=time.perf_counter(); result=call_jev(payload,key); scores={}
                for sid in ids:
                    answer=result.get('answers',{}).get(sid,{})
                    score=answer.get('score')
                    if isinstance(score,bool) or not isinstance(score,(int,float)) or not 0<=score<=3:
                        raise ValueError('Jev 返回了缺失或无效评分；本批未显示，请重试。')
                    scores[sid]=score
                return self.send(200,{'scores':scores,'elapsedMs':round((time.perf_counter()-started)*1000),'usage':result.get('usage',{}),'model':result.get('model',MODEL)})
            self.send(404,{'error':'未找到接口。'})
        except (ValueError,fitz.FileDataError) as exc: self.send(400,{'error':str(exc)})
        except Exception: self.send(500,{'error':'处理失败，请确认 PDF 可正常阅读后重试。'})

if __name__=='__main__':
    print(f'PaperFocus: http://127.0.0.1:{PORT}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',PORT),Handler).serve_forever()
