import os
import time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options

# Setup paths
artifact_dir = r"C:\Users\metzd\Documents\GitHub\Open-Float-Archery"
os.makedirs(artifact_dir, exist_ok=True)

chrome_options = Options()
chrome_options.add_argument("--headless")
chrome_options.add_argument("--window-size=1280,1000")
chrome_options.add_argument("--disable-gpu")
chrome_options.add_argument("--no-sandbox")
# Enable console log gathering
chrome_options.set_capability('goog:loggingPrefs', {'browser': 'ALL'})

driver = webdriver.Chrome(options=chrome_options)

themes = ["paper", "dark", "classic"]

try:
    for theme in themes:
        print(f"\n--- Testing theme: {theme} ---")

        # Load page and inject localStorage theme
        driver.get("http://localhost:4178/")
        time.sleep(1)
        driver.execute_script(f"localStorage.setItem('of-theme-proto', '{theme}');")
        driver.refresh()

        # Wait for IndexedDB database seed (up to 5 seconds)
        time.sleep(5)

        # Print logs to diagnose any database seeding or rendering errors
        print("Browser Logs:")
        for log in driver.get_log('browser'):
            print(f"  [{log['level']}] {log['message']}")

        # --- 1. Dashboard Tab ---
        driver.execute_script("document.getElementById('navDashboardBtn').click();")
        time.sleep(1.0)
        driver.save_screenshot(os.path.join(artifact_dir, f"dashboard_{theme}.png"))
        print(f"Captured dashboard_{theme}.png")

        # --- 2. Saved Shots Tab ---
        driver.execute_script("document.getElementById('navHistoryBtn').click();")
        time.sleep(1.0)
        driver.save_screenshot(os.path.join(artifact_dir, f"saved_shots_{theme}.png"))
        print(f"Captured saved_shots_{theme}.png")

        # --- 3. Trace Review (Open from History) ---
        try:
            items = driver.find_elements(By.CLASS_NAME, "history-item")
            if items:
                print(f"Found {len(items)} history items. Clicking first one...")
                items[0].click()
                time.sleep(1.5) # Wait for trace review draw
                driver.save_screenshot(os.path.join(artifact_dir, f"trace_review_{theme}.png"))
                print(f"Captured trace_review_{theme}.png")
                # Exit review mode to clean up state
                driver.execute_script("document.getElementById('exitReviewBtn').click();")
                time.sleep(0.5)
            else:
                print(f"No history items found for theme {theme}")
        except Exception as e:
            print(f"Could not capture trace review for theme {theme}: {e}")

        # --- 4. Steady Aim Training Tab ---
        driver.execute_script("document.getElementById('navTrainingBtn').click();")
        time.sleep(1.0)
        driver.save_screenshot(os.path.join(artifact_dir, f"steady_aim_{theme}.png"))
        print(f"Captured steady_aim_{theme}.png")

        # --- 5. Settings Tab ---
        driver.execute_script("document.getElementById('navSettingsBtn').click();")
        time.sleep(1.0)
        driver.save_screenshot(os.path.join(artifact_dir, f"settings_{theme}.png"))
        print(f"Captured settings_{theme}.png")

finally:
    driver.quit()
    print("Done taking screenshots.")
