@echo off
rem Field Shift: downloads fresh data and rebuilds what the app shows. Optional: the app already ships its data.
rem Keys (NASS, Meteomatics) go in field-shift-pipeline\.env; copy .env.example to start. Steps without a key are skipped.
cd /d "%~dp0field-shift-pipeline"
where uv >nul 2>nul || (echo uv nao encontrado. Instale com: winget install astral-sh.uv & pause & exit /b 1)
uv sync --extra planetary || (pause & exit /b 1)
uv run python -m pipeline.update_all %*
pause
