"""Find a Chromium-based browser that can create headless screenshots."""
import os
import platform
import shutil
from pathlib import Path


def find_browser() -> str:
    """Return a usable Chrome, Chromium, or Edge executable, if one is installed."""
    override = os.environ.get("DIVIDEND_BROWSER")
    if override and Path(override).is_file():
        return override

    system = platform.system()
    candidates = []
    if system == "Darwin":
        candidates.extend([
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ])
    elif system == "Windows":
        roots = [os.environ.get("PROGRAMFILES", ""), os.environ.get("PROGRAMFILES(X86)", ""),
                 os.environ.get("LOCALAPPDATA", "")]
        for root in roots:
            candidates.extend([
                os.path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
                os.path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
                os.path.join(root, "Chromium", "Application", "chrome.exe"),
            ])

    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    for command in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "msedge"):
        path = shutil.which(command)
        if path:
            return path

    raise RuntimeError(
        "未找到可用于截图的浏览器。请安装 Chrome、Chromium 或 Microsoft Edge，"
        "或设置环境变量 DIVIDEND_BROWSER 为浏览器可执行文件的完整路径。"
    )
