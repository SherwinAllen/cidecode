import os
import json
import time
from playwright.sync_api import sync_playwright

AUDIO_URLS = []  # List to store actual audio file URLs

def intercept_request(route, request):
    """Intercepts network requests and stores potential audio URLs."""
    url = request.url
    
    # Block ads and tracking to speed up page load
    if any(domain in url for domain in ['ads.', 'tracking.', 'analytics.', 'sync.']):
        # print(f"🚫 Blocked ad/tracking: {url}")
        route.abort()
        return
        
    if "audio" in url and "ads" not in url:
        print(f"🔊 Potential Audio URL: {url}")
    route.continue_()

def intercept_response(response):
    """Filters actual audio files based on content type or JSON response."""
    url = response.url
    content_type = response.headers.get("content-type", "")

    # Skip ads and tracking
    if any(domain in url for domain in ['ads.', 'tracking.', 'analytics.', 'sync.']):
        return

    try:
        if "audio" in content_type:  # Directly an audio file
            print(f"✅ Audio File Detected: {url}")
            if url not in AUDIO_URLS:
                AUDIO_URLS.append(url)

        elif "application/json" in content_type:  # Check JSON response
            # Skip redirect responses
            if 300 <= response.status < 400:
                return
            json_response = response.json()
            if isinstance(json_response, list) and json_response:
                for item in json_response:
                    if item.get("audioPlayable", False):  # Only keep playable audio
                        print(f"🔄 Found playable audio in JSON: {url}")

    except Exception as e:
        # Skip redirect errors - they're harmless
        if "redirect" not in str(e).lower():
            print(f"Error processing response from {url}: {e}")

def is_valid_audio_url(url):
    """Check if URL is likely an actual Alexa audio file"""
    audio_keywords = ['audio', 'play', 'record', 'alexa', 'apd']
    exclude_keywords = ['ad', 'ads', 'sync', 'tracking', 'analytics', 'geo.']
    
    url_lower = url.lower()
    
    # Must contain audio-related keyword
    has_audio_keyword = any(keyword in url_lower for keyword in audio_keywords)
    # Must NOT contain excluded keywords
    has_no_ads = not any(exclude in url_lower for exclude in exclude_keywords)
    
    return has_audio_keyword and has_no_ads

with sync_playwright() as p:
    # Launch the browser
    browser = p.chromium.launch(headless=False)
    context = browser.new_context()

    # Load cookies from the file
    cookies_path = os.path.join("backend", "cookies.json")
    if os.path.exists(cookies_path):    
        with open(cookies_path, "r") as f:
            cookies = json.load(f)
        context.add_cookies(cookies)
        print("✅ Cookies loaded successfully")
    else:
        print("Cookies file not found. Please run the login script first.")
        exit(1)
    
    # Open a new page
    page = context.new_page()

    # Intercept network requests & responses
    page.route("**/*", intercept_request)
    page.on("response", intercept_response)

    print("🌐 Navigating to Alexa privacy page...")
    
    # Use a more reliable navigation approach
    try:
        page.goto("https://www.amazon.in/alexa-privacy/apd/rvh", wait_until="domcontentloaded")
        print("✅ Page loaded (DOM content loaded)")
        
        # Wait for page to be interactive instead of network idle
        page.wait_for_timeout(5000)  # Wait 5 seconds for initial content
        
        # Check if we're actually on the right page and logged in
        if "signin" in page.url or page.locator("input#ap_email").count() > 0:
            print("❌ Not logged in. Please check your cookies.")
            browser.close()
            exit(1)
            
    except Exception as e:
        print(f"❌ Navigation failed: {e}")
        browser.close()
        exit(1)

    # Check for "no records" scenario first
    no_records_selectors = [
        "text=No voice recordings found",
        "text=No activities found", 
        "text=No records",
        "text=You haven't interacted with Alexa",
        ".apd-empty-state",
        ".no-records"
    ]
    
    no_records_found = False
    for selector in no_records_selectors:
        if page.locator(selector).count() > 0:
            print("✅ No voice records found on the page. This is normal if you haven't used Alexa.")
            no_records_found = True
            break

    if no_records_found:
        print("📝 No audio URLs to extract. Saving empty list.")
        # Save empty list
        audio_urls_path = os.path.join("backend", "audio_urls.json")
        with open(audio_urls_path, "w") as f:
            json.dump([], f, indent=2)
        print(f"Saved empty audio URLs list to {audio_urls_path}")
        browser.close()
        exit(0)

    # If we get here, there might be records - try to find activities
    print("🔍 Looking for voice activities...")
    
    # Try multiple possible activity container selectors with timeout
    activity_selectors = [
        "div.apd-content-box.with-activity-page",
        ".activity-container",
        "[data-testid*='activity']",
        ".voice-record-item",
        "div[class*='activity']"
    ]
    
    activities = None
    for selector in activity_selectors:
        try:
            # Wait for selector to appear with a reasonable timeout
            page.wait_for_selector(selector, timeout=10000)
            activities = page.locator(selector)
            if activities.count() > 0:
                print(f"✅ Found {activities.count()} activities using selector: {selector}")
                break
        except:
            continue
    
    if activities is None or activities.count() == 0:
        print("ℹ️ No voice activity containers found. This could mean:")
        print("   - You have no Alexa voice records")
        print("   - The page structure has changed")
        print("   - There's a regional difference in the website")
        
        # Take a screenshot for debugging
        page.screenshot(path="debug_no_activities.png")
        print("📸 Saved screenshot as 'debug_no_activities.png' for inspection")
        
        # Save empty list and exit gracefully
        audio_urls_path = os.path.join("backend", "audio_urls.json")
        with open(audio_urls_path, "w") as f:
            json.dump([], f, indent=2)
        print(f"Saved empty audio URLs list to {audio_urls_path}")
        browser.close()
        exit(0)

    # If we found activities, proceed with processing
    activity_count = activities.count()
    print(f"🎯 Found {activity_count} activities to process.")

    for i in range(activity_count):
        activity = activities.nth(i)
        print(f"Processing activity {i+1}/{activity_count}...")

        # Try to find and click expand button
        expand_buttons = [
            "button.apd-expand-toggle-button",
            "button[aria-label*='expand']",
            "button[aria-label*='more']",
            ".expand-button",
            "button:has(svg, .fa-chevron-down)"
        ]
        
        expanded = False
        for btn_selector in expand_buttons:
            if activity.locator(btn_selector).count() > 0:
                try:
                    activity.locator(btn_selector).first.click()
                    page.wait_for_timeout(1000)
                    expanded = True
                    print(f"   ➕ Expanded activity {i+1}")
                    break
                except:
                    continue
        
        if expanded:
            # Try to find and click play button
            play_buttons = [
                "button.play-audio-button",
                "button[aria-label*='play']",
                "button[aria-label*='audio']",
                ".play-button",
                "button:has(svg, .fa-play)"
            ]
            
            for play_selector in play_buttons:
                if activity.locator(play_selector).count() > 0:
                    try:
                        activity.locator(play_selector).first.click()
                        print(f"   🎵 Clicked play audio button.")
                        time.sleep(3)  # Wait for request to be made
                        break
                    except:
                        continue
            else:
                print(f"   ℹ️ Play audio button not found")
        else:
            print(f"   ℹ️ Expand button not found")

    # Filter out ad/tracking URLs and keep only valid audio URLs
    valid_audio_urls = [url for url in AUDIO_URLS if is_valid_audio_url(url)]
    
    # Save only valid audio URLs
    audio_urls_path = os.path.join("backend", "audio_urls.json")
    with open(audio_urls_path, "w") as f:
        json.dump(valid_audio_urls, f, indent=2)
        
    print(f"✅ Extraction complete! Found {len(valid_audio_urls)} valid audio URLs.")
    if valid_audio_urls:
        for url in valid_audio_urls:
            print(f"   🔊 {url}")
    print(f"💾 Saved to {audio_urls_path}")

    browser.close()