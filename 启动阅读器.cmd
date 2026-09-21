@echo off
cd /d "%~dp0"
python -c "import fitz" >nul 2>&1
if errorlevel 1 (
  echo Install dependencies first: python -m pip install -r requirements.txt
  pause
  exit /b 1
)
start "" http://127.0.0.1:8765
python server.py
pause
