"""Capture the three README image-spot screenshots into docs/images/.

Uses the demo stream (header Demo button) for live motion, the seeded sample
shots for review, and a mid-hold Steady Aim drill. Serve the repo first:
    python -m http.server 4811
"""

import os
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "images")
BASE_URL = "http://localhost:4811/"

options = Options()
options.add_argument("--headless")
options.add_argument("--window-size=1400,1000")
options.add_argument("--disable-gpu")
options.add_argument("--no-sandbox")
options.add_argument("--force-device-scale-factor=1")

driver = webdriver.Chrome(options=options)


def shot(name):
    path = os.path.abspath(os.path.join(OUT_DIR, name))
    driver.save_screenshot(path)
    print(f"captured {path}")


def js(script):
    return driver.execute_script(script)


try:
    driver.get(BASE_URL)
    time.sleep(5)  # IndexedDB seed + module init

    # --- Spot 3: live dashboard with the demo stream running ---
    js("document.getElementById('demoBtn').click();")
    time.sleep(6)  # let the Hz counter settle and the trace build up
    js("window.scrollTo(0, 0);")
    shot("dashboard-live.png")

    # --- Spot 4: Pin Float review of a saved sample shot ---
    js("document.getElementById('demoBtn').click();")  # stop demo first
    time.sleep(1)
    js("document.querySelector('#recentShotsList > *').click();")
    time.sleep(2)  # review chart + replay draw
    # Frame the trace chart, review banner (Float Score), and replay scrubber.
    js("window.scrollTo(0, 380);")
    time.sleep(0.5)
    shot("shot-review-pin-float.png")
    js("window.scrollTo(0, 0);")
    js("document.getElementById('exitReviewBtn').click();")
    time.sleep(1)

    # --- Spot 5: Steady Aim mid-hold with the demo stream as input ---
    js("document.getElementById('demoBtn').click();")
    time.sleep(2)  # demo connected -> Start Training enables
    js("document.getElementById('navTrainingBtn').click();")
    time.sleep(1)
    js("document.getElementById('startTrainingBtn').click();")
    time.sleep(9)  # 5 s prep countdown + ~4 s into the hold
    shot("steady-aim-session.png")
finally:
    driver.quit()
    print("done")
