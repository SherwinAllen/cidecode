import os
import json
import re
import time
from playwright.sync_api import sync_playwright # type: ignore
from datetime import datetime
from dotenv import load_dotenv # type: ignore

load_dotenv()
HEADLESS = os.getenv("HEADLESS", "true").lower() == "true"

# Global lists to track processed data
ALL_TRANSCRIPTS = []

# Output files
AUDIO_URLS_FILE = os.path.join("backend", "audio_urls.json")
TRANSCRIPTS_FILE = "alexa_activity_log.txt"

RETRY_SLEEP = 1 
MAX_INITIAL_BATCH_ATTEMPTS = 3

# Track audio URLs by activity
activity_audio_map = {}
audio_request_tracker = {}

# Track play button clicks with timestamps
play_button_clicks = []

# Optimization: Cache for element selectors
selector_cache = {}

def get_recent_play_clicks():
    """Get recent play button clicks for audio correlation"""
    return play_button_clicks.copy()

def record_play_button_click(activity_num):
    """Record when a play button is clicked for precise audio correlation"""
    global play_button_clicks
    
    click_time = datetime.now().timestamp()
    play_button_clicks.append((activity_num, click_time))
    # Keep only recent clicks to avoid memory bloat
    current_time = datetime.now().timestamp()
    play_button_clicks = [(a, t) for a, t in play_button_clicks if current_time - t < 30]

def intercept_request(route, request):
    """Intercepts network requests and stores potential audio URLs."""
    url = request.url
    
    # Block ads and tracking to speed up page load
    if any(domain in url for domain in ['ads.', 'tracking.', 'analytics.', 'sync.']):
        route.abort()
        return
        
    # Track audio requests with timestamp for precise correlation
    if is_valid_audio_url(url):
        request_id = f"{url}_{datetime.now().timestamp()}"
        audio_request_tracker[request_id] = {
            'url': url,
            'timestamp': datetime.now().timestamp(),
            'headers': dict(request.headers),
            'activity_num': None
        }
        print(f"   🔊 Audio Request: {url.split('/')[-1][:50]}...")
        
    route.continue_()

def is_valid_audio_url(url):
    """Check if URL is likely an actual Alexa audio file"""
    url_lower = url.lower()
    
    # Must be from Amazon Alexa privacy domain
    if 'amazon.in/alexa-privacy/apd/rvh/audio' not in url_lower:
        return False
        
    # Must have uid parameter (indicates it's a specific audio file)
    if 'uid=' not in url_lower:
        return False
        
    # Exclude the playability check endpoint
    if 'is-audio-playable' in url_lower:
        return False
    
    return True

def save_audio_url(url, activity_num):
    """Save audio URL with activity number and timestamp"""
    if not is_valid_audio_url(url):
        return False
    
    # Read existing data
    existing_data = []
    try:
        if os.path.exists(AUDIO_URLS_FILE):
            with open(AUDIO_URLS_FILE, "r") as f:
                existing_data = json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        existing_data = []
    
    # Create entry with activity number and timestamp
    audio_entry = {
        "activity_number": activity_num,
        "url": url,
        "timestamp": datetime.now().isoformat()
    }
    
    # Check if this URL already exists for this activity (avoid duplicates)
    existing_for_activity = [entry for entry in existing_data if entry["activity_number"] == activity_num and entry["url"] == url]
    if existing_for_activity:
        return True  # Already saved for this activity
    
    # Add to existing data
    existing_data.append(audio_entry)
    
    # Save updated list
    with open(AUDIO_URLS_FILE, "w") as f:
        json.dump(existing_data, f, indent=2)
    
    print(f"   💾 Audio for Activity {activity_num}")
    
    # Track in memory for current session
    if activity_num not in activity_audio_map:
        activity_audio_map[activity_num] = []
    activity_audio_map[activity_num].append(url)
    
    return True

def intercept_response(response):
    """Intercept responses and immediately save audio URLs based on recent play button clicks."""
    url = response.url
    
    if not is_valid_audio_url(url):
        return

    try:
        # Find the most recent play button click and assign audio to that activity
        current_time = datetime.now().timestamp()
        
        # Look for play button clicks in the last 10 seconds
        recent_play_clicks = get_recent_play_clicks()
        valid_recent_clicks = []
        
        for activity_num, click_time in recent_play_clicks:
            if current_time - click_time < 10:  # 10 second window
                valid_recent_clicks.append((activity_num, click_time))
        
        if valid_recent_clicks:
            # Sort by most recent
            valid_recent_clicks.sort(key=lambda x: x[1], reverse=True)
            most_recent_activity = valid_recent_clicks[0][0]
            
            # Save audio for this activity
            if save_audio_url(url, most_recent_activity):
                print(f"   ✅ Audio assigned to Activity {most_recent_activity}")

    except Exception as e:
        pass

def extract_speaker_and_device(activity):
    """Extract speaker name and device name from activity - OPTIMIZED"""
    speaker_name = "Unknown"
    device_name = "Unknown"
    
    # Use cached selectors for better performance
    if 'speaker_device_selectors' not in selector_cache:
        selector_cache['speaker_device_selectors'] = {
            'speaker': ["div.profile-name.activity-level", ".profile-name.activity-level"],
            'device': ["div.device-name", ".device-name"]
        }
    
    selectors = selector_cache['speaker_device_selectors']
    
    # Try speaker selectors
    for selector in selectors['speaker']:
        try:
            speaker_element = activity.locator(selector)
            if speaker_element.count() > 0:
                speaker_text = speaker_element.first.inner_text().strip()
                if speaker_text and speaker_text != "Unknown":
                    speaker_name = speaker_text
                    break
        except:
            continue
    
    # Try device selectors
    for selector in selectors['device']:
        try:
            device_element = activity.locator(selector)
            if device_element.count() > 0:
                device_text = device_element.first.inner_text().strip()
                if device_text:
                    device_name = device_text
                    break
        except:
            continue
    
    return speaker_name, device_name

def extract_timestamp_from_activity(activity):
    """Extract timestamp from activity - OPTIMIZED"""
    day = "Unknown"
    time_str = "Unknown"
    
    try:
        # Cache selectors
        if 'timestamp_selectors' not in selector_cache:
            selector_cache['timestamp_selectors'] = {
                'day': ["div.record-info.ellipsis-overflow.with-activity-page.expanded > div:nth-child(1)", "div.item"],
                'time': ["div.record-info.ellipsis-overflow.with-activity-page.expanded > div:nth-child(2)", "div.item:nth-child(2)"]
            }
        
        selectors = selector_cache['timestamp_selectors']
        
        # Extract day
        for selector in selectors['day']:
            try:
                day_element = activity.locator(selector)
                if day_element.count() > 0:
                    day_text = day_element.first.inner_text().strip()
                    if day_text and day_text not in ["", "Unknown"]:
                        day = day_text
                        break
            except:
                continue
        
        # Extract time
        for selector in selectors['time']:
            try:
                time_element = activity.locator(selector)
                if time_element.count() > 0:
                    time_text = time_element.first.inner_text().strip()
                    if time_text and time_text not in ["", "Unknown"]:
                        time_str = time_text
                        break
            except:
                continue
        
        # Combine day and time
        if day != "Unknown" and time_str != "Unknown":
            return f"{day} {time_str}"
        elif day != "Unknown":
            return day
        elif time_str != "Unknown":
            return time_str
        else:
            return "Unknown"
            
    except Exception as e:
        return "Unknown"

def extract_transcript_preserving_quotes(raw_text, speaker_name, device_name):
    """Extract transcript while preserving exact text from Amazon page - OPTIMIZED"""
    if not raw_text.strip():
        return "[No transcript available]"
    
    lines = raw_text.strip().split('\n')
    transcript_lines = []
    
    # Pre-compile patterns for better performance
    timestamp_pattern = re.compile(r'^(Today|Yesterday|\d{1,2} \w+ \d{4}).*(am|pm)', re.IGNORECASE)
    
    for line in lines:
        line = line.strip()
        
        # Skip empty lines
        if not line:
            continue
            
        # Skip timestamp lines (optimized with pre-compiled pattern)
        if timestamp_pattern.search(line):
            continue
            
        # Skip speaker/device duplicates (only if they appear as standalone lines)
        if (speaker_name != "Unknown" and line == speaker_name) or (device_name != "Unknown" and line == device_name):
            continue
            
        # Skip label lines
        if line.lower() in ['transcript:', 'command:', 'response:']:
            continue
            
        transcript_lines.append(line)
    
    # Join transcript lines - PRESERVE ORIGINAL FORMATTING
    transcript = '\n'.join(transcript_lines)
    
    # Remove excessive whitespace but preserve line breaks for multi-line transcripts
    transcript = re.sub(r'[ \t]+', ' ', transcript)  # Normalize spaces within lines
    transcript = re.sub(r'\n +', '\n', transcript)   # Remove leading spaces after newlines
    transcript = transcript.strip()
    
    # CRITICAL FIX: Don't filter out system activities - return whatever text remains
    # This ensures we get the exact text from Amazon page, whether it's quoted or system text
    return transcript if transcript else "[No transcript available]"

def extract_single_transcript(activity, activity_num):
    """Extract transcript from a single activity - OPTIMIZED"""
    try:
        # Extract speaker, device, and timestamp
        speaker_name, device_name = extract_speaker_and_device(activity)
        timestamp = extract_timestamp_from_activity(activity)
        
        # Get the raw text content
        raw_text = activity.inner_text()
        
        # Extract transcript while preserving quotes and structure
        transcript = extract_transcript_preserving_quotes(raw_text, speaker_name, device_name)
        
        # Create enhanced transcript
        transcript_data = f"""--- Activity {activity_num} ---
Speaker: {speaker_name}
Device: {device_name}
Timestamp: {timestamp}
Transcript: {transcript}
"""
        return transcript_data
            
    except Exception as e:
        return f"""--- Activity {activity_num} ---
Speaker: Unknown
Device: Unknown
Timestamp: Unknown
Transcript: [Error extracting transcript: {e}]
"""

def find_and_click_play_button_deterministic(activity, activity_num, max_attempts=3):
    """Deterministically find and click play button - OPTIMIZED"""
    # Cache play button selectors
    if 'play_button_selectors' not in selector_cache:
        selector_cache['play_button_selectors'] = [
            "button.play-audio-button",
            "button[aria-label*='play']",
            "button[aria-label*='audio']",
            "button[class*='play']",
            "button[class*='audio']",
            "button i.fa-play",
            "button i.fa-volume-up"
        ]
    
    play_button_selectors = selector_cache['play_button_selectors']
    
    for attempt in range(max_attempts):
        for selector in play_button_selectors:
            try:
                play_buttons = activity.locator(selector)
                count = play_buttons.count()
                
                if count > 0:
                    # Wait for element to be visible (reduced timeout)
                    play_buttons.first.wait_for(state="visible", timeout=3000)
                    
                    # Scroll into view
                    play_buttons.first.scroll_into_view_if_needed()
                    
                    # Shorter delay for stability
                    time.sleep(0.3)
                    
                    print(f"      🎵 Play button {activity_num} (attempt {attempt + 1})...")
                    
                    # Record the click timestamp for precise audio correlation
                    record_play_button_click(activity_num)
                    
                    # Click with force in case element is covered
                    play_buttons.first.click(force=True, timeout=3000)
                    
                    # Wait for audio request to be triggered (KEEP ORIGINAL TIMING)
                    time.sleep(0.5)
                    
                    # Check if any audio requests were made recently
                    recent_clicks = get_recent_play_clicks()
                    current_time = datetime.now().timestamp()
                    recent_audio_requests = [
                        req for req in audio_request_tracker.values()
                        if is_valid_audio_url(req['url']) and current_time - req['timestamp'] < 5
                    ]
                    
                    if recent_audio_requests:
                        print(f"      ✅ Play button successful {activity_num}")
                        return True
                    else:
                        print(f"      ⚠️ No audio detected, retrying...")
                        continue
                        
            except Exception as e:
                continue
        
        # If no success with any selector, wait and retry
        if attempt < max_attempts - 1:
            print(f"      🔄 Retrying play button {activity_num}...")
            time.sleep(0.75)
    
    return False

def ensure_activity_expanded(activity, activity_num):
    """Ensure activity is expanded to reveal play button - OPTIMIZED"""
    if 'expand_selectors' not in selector_cache:
        selector_cache['expand_selectors'] = [
            "button.apd-expand-toggle-button",
            "button.button-clear.fa.fa-chevron-down", 
            "button[aria-label*='expand']",
            ".apd-expand-toggle-button"
        ]
    
    expand_selectors = selector_cache['expand_selectors']
    
    for selector in expand_selectors:
        try:
            expand_buttons = activity.locator(selector)
            if expand_buttons.count() > 0:
                # Get the class to check current state
                class_attr = expand_buttons.first.get_attribute("class") or ""
                if "fa-chevron-down" in class_attr:
                    # If it's a chevron-down, it means it's collapsed, so click to expand
                    expand_buttons.first.click()
                    time.sleep(0.3)  # Reduced from 0.5
                    print(f"      📂 Expanded {activity_num}")
                return True
        except Exception:
            continue
    
    return False

def process_activity_batch(activities, start_index, end_index, total_activities):
    """Process a batch of activities efficiently"""
    batch_results = []
    
    for i in range(start_index, end_index):
        try:
            activity = activities.nth(i)
            activity_num = i + 1
            
            # Extract transcript first
            transcript_data = extract_single_transcript(activity, activity_num)
            batch_results.append((activity_num, transcript_data))
            
            # Initialize audio tracking for this activity
            if activity_num not in activity_audio_map:
                activity_audio_map[activity_num] = []

            # Ensure activity is expanded
            ensure_activity_expanded(activity, activity_num)
            
            # Shorter UI stabilization
            time.sleep(0.3)
            
            # Find and click play button
            audio_clicked = find_and_click_play_button_deterministic(activity, activity_num)
            
            if not audio_clicked:
                print(f"      🚨 No play button {activity_num}")
            
            # Wait for audio load (KEEP ORIGINAL TIMING)
            time.sleep(0.5)
            
        except Exception as e:
            error_transcript = f"""--- Activity {i + 1} ---
Speaker: Unknown
Device: Unknown
Timestamp: Unknown
Transcript: [Error processing activity: {e}]
"""
            batch_results.append((i + 1, error_transcript))
    
    return batch_results

def process_single_activity_deterministic(activity, activity_num, total_activities):
    """Process single activity with guaranteed audio extraction - OPTIMIZED"""
    # Extract transcript first
    transcript_data = extract_single_transcript(activity, activity_num)
    ALL_TRANSCRIPTS.append(transcript_data)

    # Initialize audio tracking for this activity
    if activity_num not in activity_audio_map:
        activity_audio_map[activity_num] = []

    # Step 1: Ensure activity is expanded
    ensure_activity_expanded(activity, activity_num)
    
    # Step 2: Wait a moment for UI to stabilize (reduced)
    time.sleep(0.3)
    
    # Step 3: Deterministically find and click play button
    audio_clicked = find_and_click_play_button_deterministic(activity, activity_num)
    
    if not audio_clicked:
        print(f"      🚨 No play button {activity_num}")
        
    # Step 4: Wait for audio to load (KEEP ORIGINAL TIMING)
    time.sleep(0.5)
    
    return True

def initialize_output_files(clear_existing=False):
    """Initialize all output files"""
    global activity_audio_map, audio_request_tracker, play_button_clicks, selector_cache
    
    os.makedirs(os.path.dirname(AUDIO_URLS_FILE), exist_ok=True)
    
    if clear_existing or not os.path.exists(AUDIO_URLS_FILE):
        with open(AUDIO_URLS_FILE, "w") as f:
            json.dump([], f, indent=2)
    
    ALL_TRANSCRIPTS.clear()
    activity_audio_map.clear()
    audio_request_tracker.clear()
    play_button_clicks.clear()
    selector_cache.clear()

def find_all_activities(page):
    """Find all activity containers on the page - OPTIMIZED"""
    # Use cached selector
    if 'activity_selectors' not in selector_cache:
        selector_cache['activity_selectors'] = [
            "div.apd-content-box.with-activity-page",
            ".apd-content-box.with-activity-page", 
            "[class*='apd-content-box']"
        ]
    
    selectors = selector_cache['activity_selectors']
    
    for selector in selectors:
        try:
            activities = page.locator(selector)
            count = activities.count()
            if count > 0:
                return activities
        except:
            continue
    
    return None

def fast_scroll_to_load_more(page, current_processed_count):
    """Fast scrolling to load more activities - OPTIMIZED"""
    try:
        # Scroll to trigger lazy loading (same logic as original)
        activities = find_all_activities(page)
        if activities and current_processed_count > 0:
            scroll_index = max(0, current_processed_count - 2)
            try:
                activities.nth(scroll_index).scroll_into_view_if_needed()
                time.sleep(0.5)
            except:
                pass
        
        # Single fast scroll instead of multiple
        page.evaluate("window.scrollBy(0, 800)")
        time.sleep(0.5)
        
        return True
        
    except Exception:
        # Fallback: quick scroll
        page.evaluate("window.scrollBy(0, 600)")
        time.sleep(0.5)
        return True

def continuous_load_and_process_optimized(page):
    """Continuous loading and processing - HEAVILY OPTIMIZED"""
    print("🔄 Starting loading and processing...")
    
    total_processed = 0
    consecutive_no_new_count = 0
    max_consecutive_no_new = 2
    
    # Get initial activity count
    initial_activities = find_all_activities(page)
    if not initial_activities:
        return 0
        
    initial_count = initial_activities.count()
    print(f"   📊 Found {initial_count} activities")
    
    # Use dynamic batch sizing based on total activities
    if initial_count <= 20:
        batch_size = 5
    elif initial_count <= 40:
        batch_size = 8
    else:
        batch_size = 10
    
    processed_activities = set()
    
    while consecutive_no_new_count < max_consecutive_no_new:
        # Find current activities
        activities = find_all_activities(page)
        if not activities:
            consecutive_no_new_count += 1
            break
            
        current_activity_count = activities.count()
        
        # Check if we've already processed all available activities
        if total_processed >= current_activity_count:
            consecutive_no_new_count += 1
            
            # Try scrolling to load more
            fast_scroll_to_load_more(page, total_processed)
            time.sleep(0.5)  # Reduced from 2
            
            # Check again after scrolling
            new_activities = find_all_activities(page)
            if new_activities and new_activities.count() > current_activity_count:
                consecutive_no_new_count = 0
                continue
            else:
                if consecutive_no_new_count >= max_consecutive_no_new:
                    break
                continue
        
        # Reset consecutive no new count since we found new activities
        consecutive_no_new_count = 0
        
        # Process activities in current batch
        start_index = total_processed
        end_index = min(current_activity_count, start_index + batch_size)
        
        print(f"   🔄 Processing {start_index + 1} to {end_index}")
        
        # Process batch
        for i in range(start_index, end_index):
            if i in processed_activities:
                continue
                
            try:
                activity = activities.nth(i)
                process_single_activity_deterministic(activity, i + 1, current_activity_count)
                total_processed += 1
                processed_activities.add(i)
                
                # Reduced delay between activities
                time.sleep(0.3)
                
            except Exception as e:
                error_transcript = f"""--- Activity {i + 1} ---
Speaker: Unknown
Device: Unknown
Timestamp: Unknown
Transcript: [Error processing activity: {e}]
"""
                ALL_TRANSCRIPTS.append(error_transcript)
                total_processed += 1
                processed_activities.add(i)
                continue
        
        print(f"   ✅ Processed {end_index - start_index} activities")
        print(f"   📈 Total: {total_processed}/{current_activity_count}")
        
        # Scroll to load more activities
        fast_scroll_to_load_more(page, total_processed)
        
        # Quick check if we have more activities after scrolling
        new_activities = find_all_activities(page)
        if new_activities:
            new_count = new_activities.count()
            if new_count <= current_activity_count:
                consecutive_no_new_count += 1
            else:
                consecutive_no_new_count = 0
        else:
            consecutive_no_new_count += 1
    
    return total_processed

def save_final_outputs():
    """Save all final output files"""
    with open(TRANSCRIPTS_FILE, "w", encoding="utf-8") as f:
        for transcript in ALL_TRANSCRIPTS:
            f.write(transcript + "\n")

def post_process_audio_assignment():
    """Post-process to ensure all activities have audio URLs assigned"""
    print("🔍 Post-processing audio assignment...")
    
    # Read saved audio data
    try:
        with open(AUDIO_URLS_FILE, "r") as f:
            audio_data = json.load(f)
    except:
        audio_data = []
    
    # Group by activity
    audio_by_activity = {}
    for entry in audio_data:
        activity_num = entry["activity_number"]
        if activity_num not in audio_by_activity:
            audio_by_activity[activity_num] = []
        audio_by_activity[activity_num].append(entry)
    
    # Check for missing audio
    missing_audio = []
    for i in range(1, len(ALL_TRANSCRIPTS) + 1):
        if i not in audio_by_activity or not audio_by_activity[i]:
            missing_audio.append(i)
    
    if missing_audio:
        print(f"   ⚠️  Missing audio: {missing_audio}")
        print(f"   🔄 Recovering missing audio...")
        
        # Check if we have unassigned audio requests
        for activity_num in missing_audio:
            for req_id, req_data in audio_request_tracker.items():
                if req_data.get('activity_num') is None and is_valid_audio_url(req_data['url']):
                    if save_audio_url(req_data['url'], activity_num):
                        print(f"   ✅ Recovered audio {activity_num}")
                        break
    
    return len(missing_audio)

# ========== OPTIMIZED MAIN EXECUTION ==========
print("🚀 Starting Alexa Audio & Transcript Extraction")
print("=" * 60)

with sync_playwright() as p:
    # Initialize all output files
    initialize_output_files(clear_existing=True)

    # Launch the browser
    browser = p.chromium.launch(headless=HEADLESS, args=["--mute-audio"])
    context = browser.new_context()

    # Load cookies from the file
    cookies_path = os.path.join("backend", "cookies.json")
    if os.path.exists(cookies_path):    
        with open(cookies_path, "r") as f:
            cookies = json.load(f)
        context.add_cookies(cookies)
        print("✅ Cookies loaded")
    else:
        print("❌ Cookies file not found.")
        exit(1)
    
    # Open a new page
    page = context.new_page()

    # Intercept network requests & responses
    page.route("**/*", intercept_request)
    page.on("response", intercept_response)

    print("🌐 Navigating to Alexa privacy page...")
    
    try:
        page.goto("https://www.amazon.in/alexa-privacy/apd/rvh", wait_until="domcontentloaded")
        
        # Check if we're actually on the right page and logged in
        if "signin" in page.url or page.locator("input#ap_email").count() > 0:
            print("❌ Not logged in.")
            browser.close()
            exit(1)
            
    except Exception as e:
        print(f"❌ Navigation failed: {e}")
        browser.close()
        exit(1)

    # Apply date filter
    print("\n📅 Setting date filter to 'Last 7 days'...")
    try:
        filter_button = page.locator("#filters-selected-bar > button")
        if filter_button.count() > 0:
            filter_button.click()
            time.sleep(0.8)  # Reduced from 1
            
            date_filter = page.locator("#filter-menu > div.expanded-filter-menu > div.filter-by-date-menu.false > div > button")
            if date_filter.count() > 0:
                date_filter.click()
                time.sleep(0.8)  # Reduced from 1
                
                last_7_days = page.locator("#filter-menu > div.expanded-filter-menu > div.filter-by-date-menu.false > div.filter-options-list > div:nth-child(3) > span.apd-radio-button.fa-stack.fa-2x.undefined > i")
                if last_7_days.count() > 0:
                    last_7_days.click()
                    time.sleep(1)  # Reduced from 2
                    print("✅ Date filter applied")
    except Exception as e:
        print(f"⚠️  Date filter not applied: {e}")

    # Wait for page to load activities — prefer retry if initial batch is zero
    print("⏳ Checking for initial batch of activities...")
    attempt = 1
    activities = None

    while attempt <= MAX_INITIAL_BATCH_ATTEMPTS:
        try:
            activities = find_all_activities(page)
            if activities:
                try:
                    count = activities.count()
                except Exception:
                    # If Playwright throws for any reason, treat as 0 and retry
                    count = 0
            else:
                count = 0
        except Exception:
            count = 0

        if count > 0:
            print(f"✅ Found {count} activities on attempt {attempt}. Proceeding.")
            break

        # no activities found — decide next step
        if attempt < MAX_INITIAL_BATCH_ATTEMPTS:
            print(f"⚠️ No activities found on attempt {attempt}. Sleeping {RETRY_SLEEP}s and retrying...")
            time.sleep(RETRY_SLEEP)
            attempt += 1
        else:
            print(f"⚠️ No activities found after {MAX_INITIAL_BATCH_ATTEMPTS} attempts. Proceeding anyway.")
            break

    # Now start processing
    start_time = time.time()
    total_processed = continuous_load_and_process_optimized(page)

    end_time = time.time()
    processing_time = end_time - start_time

    print(f"\n📊 PROCESSING COMPLETE in {processing_time:.1f}s")
    print(f"   • Total activities processed: {total_processed}")
    print(f"   • Transcripts extracted: {len(ALL_TRANSCRIPTS)}")

    # Post-process to ensure 100% audio extraction
    print("\n🔍 VERIFYING AUDIO EXTRACTION...")
    remaining_missing = post_process_audio_assignment()

    # Final wait for any remaining audio URLs (reduced)
    print("⏳ Finalizing audio extraction...")
    time.sleep(0.8)  # Reduced from 5

    # Save all final outputs
    save_final_outputs()

    # Analyze final results
    try:
        with open(AUDIO_URLS_FILE, "r") as f:
            final_audio_data = json.load(f)
    except:
        final_audio_data = []

    audio_by_activity = {}
    for entry in final_audio_data:
        activity_num = entry["activity_number"]
        if activity_num not in audio_by_activity:
            audio_by_activity[activity_num] = []
        audio_by_activity[activity_num].append(entry)

    total_audio_entries = sum(len(urls) for urls in audio_by_activity.values())
    activities_with_audio = list(audio_by_activity.keys())
    activities_without_audio = [num for num in range(1, total_processed + 1) if num not in audio_by_activity]

    print(f"\n🎯 FINAL AUDIO ANALYSIS:")
    print(f"   • Total audio URLs: {total_audio_entries}")
    print(f"   • Activities with audio: {len(activities_with_audio)}")
    print(f"   • Activities without audio: {len(activities_without_audio)}")
    
    if activities_without_audio:
        print(f"   ⚠️  Missing audio: {activities_without_audio}")

    # Calculate final success rate
    success_rate = (len(activities_with_audio) / total_processed) * 100 if total_processed > 0 else 0
    
    print(f"\n✅ OPTIMIZED EXTRACTION COMPLETE in {processing_time:.1f} seconds!")
    print("=" * 60)
    print(f"📊 OPTIMIZED STATISTICS:")
    print(f"   • Total activities: {total_processed}")
    print(f"   • Audio URLs: {total_audio_entries}")
    print(f"   • Transcripts: {len(ALL_TRANSCRIPTS)}")
    print(f"   • Audio success rate: {success_rate:.1f}%")
    print(f"   • Processing speed: {total_processed/(processing_time/60):.1f} activities/minute")
    
    if success_rate < 100:
        print(f"   🚨 CRITICAL: {100-success_rate:.1f}% audio failure!")
    else:
        print(f"   🎉 SUCCESS: 100% audio extraction!")
    
    print(f"\n💾 OUTPUT FILES:")
    print(f"   • Audio URLs: {AUDIO_URLS_FILE}")
    print(f"   • Transcripts: {TRANSCRIPTS_FILE}")
    print("=" * 60)

    # Close browser
    time.sleep(0.5)
    browser.close()