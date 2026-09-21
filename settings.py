"""Small .env reader. Never executes values or overwrites process environment."""
import os

def read_env(path):
    values={}
    if not path.exists(): return values
    for raw in path.read_text(encoding='utf-8-sig').splitlines():
        line=raw.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        key,value=line.split('=',1);key=key.strip();value=value.strip()
        if key not in {'TYPESAFE_API_KEY','TYPESAFE_MODEL','TYPESAFE_PROXY','PORT','MAX_PDF_MB'}: continue
        if len(value)>=2 and value[0]==value[-1] and value[0] in {'"',"'"}: value=value[1:-1]
        values[key]=value
    return values

def load_env(path):
    for key,value in read_env(path).items(): os.environ.setdefault(key,value)
