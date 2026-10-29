"""Opt-in request timing, enabled by DIVIDEND_DIAGNOSTICS_DIR."""
import datetime as dt
import json
import os
from pathlib import Path
import threading
import time
import traceback
import uuid
from urllib.parse import urlsplit

_lock = threading.Lock()
_installed = False


def record(event, **fields):
    folder = os.environ.get('DIVIDEND_DIAGNOSTICS_DIR')
    if not folder:
        return
    path = Path(folder)
    path.mkdir(parents=True, exist_ok=True)
    entry = dict(time=dt.datetime.now().isoformat(), pid=os.getpid(), event=event, **fields)
    with _lock, (path / f'network-{os.getpid()}.jsonl').open('a', encoding='utf-8') as out:
        out.write(json.dumps(entry, ensure_ascii=False, default=str) + '\n')


def install():
    global _installed
    if _installed or not os.environ.get('DIVIDEND_DIAGNOSTICS_DIR'):
        return
    _installed = True
    import requests
    import urllib.request

    def traced(call, library, url, args, kwargs):
        parts = urlsplit(url)
        endpoint = f'{parts.scheme}://{parts.hostname}{parts.path}'
        request_id = uuid.uuid4().hex
        start = time.perf_counter()
        record('request_start', request_id=request_id, library=library,
               endpoint=endpoint, timeout=kwargs.get('timeout'))
        try:
            response = call(*args, **kwargs)
            record('request_end', request_id=request_id, endpoint=endpoint,
                   elapsed=round(time.perf_counter() - start, 3),
                   status=getattr(response, 'status_code', getattr(response, 'status', None)))
            return response
        except Exception as exc:
            record('request_error', request_id=request_id, endpoint=endpoint,
                   elapsed=round(time.perf_counter() - start, 3),
                   error_type=type(exc).__name__, error=str(exc), traceback=traceback.format_exc())
            raise

    original_send = requests.Session.send
    def send(session, request, **kwargs):
        return traced(original_send, 'requests', request.url, (session, request), kwargs)
    requests.Session.send = send
    original_urlopen = urllib.request.urlopen
    def urlopen(url, *args, **kwargs):
        address = getattr(url, 'full_url', url)
        return traced(original_urlopen, 'urllib', address, (url, *args), kwargs)
    urllib.request.urlopen = urlopen


if __name__ == '__main__':
    import runpy
    install()
    runpy.run_path(str(Path(__file__).with_name('export_sheet_pic.py')), run_name='__main__')
