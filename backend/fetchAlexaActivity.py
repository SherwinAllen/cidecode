import os
import json
import re
import time
from playwright.sync_api import sync_playwright

# Global sets and lists to track processed data
PROCESSED_URLS = set()
ALL_TRANSCRIPTS = []

# Output files
AUDIO_URLS_FILE = os.path.join("backend", "audio_urls.json")
TRANSCRIPTS_FILE = "alexa_activity_log.txt"

def intercept_request(route, request):
    """Intercepts network requests and stores potential audio URLs."""
    url = request.url
    
    # Block ads and tracking to speed up page load
    if any(domain in url for domain in ['ads.', 'tracking.', 'analytics.', 'sync.']):
        route.abort()
        return
        
    if "audio" in url and "ads" not in url:
        print(f"   🔊 Network Request: {url}")
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

def save_audio_url(url):
    """Save a valid audio URL to the JSON file immediately"""
    if url in PROCESSED_URLS:
        return False
        
    if not is_valid_audio_url(url):
        return False
    
    PROCESSED_URLS.add(url)
    
    # Read existing URLs
    existing_urls = []
    
    try:
        if os.path.exists(AUDIO_URLS_FILE):
            with open(AUDIO_URLS_FILE, "r") as f:
                existing_urls = json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        existing_urls = []
    
    # Add new URL if not already present
    if url not in existing_urls:
        existing_urls.append(url)
        
        # Save updated list
        with open(AUDIO_URLS_FILE, "w") as f:
            json.dump(existing_urls, f, indent=2)
        
        print(f"   💾 IMMEDIATELY SAVED: {url}")
        print(f"   📊 Total saved so far: {len(existing_urls)}")
        return True
    
    return False

def intercept_response(response):
    """Filters actual audio files based on content type and saves valid ones immediately."""
    url = response.url
    content_type = response.headers.get("content-type", "")

    # Skip ads and tracking
    if any(domain in url for domain in ['ads.', 'tracking.', 'analytics.', 'sync.']):
        return

    try:
        if "audio" in content_type:  # Directly an audio file
            print(f"   🎵 AUDIO DETECTED: {url}")
            
            # Try to save immediately
            if save_audio_url(url):
                print(f"   ✅ Successfully saved audio URL")
            else:
                print(f"   ⚠️ Audio URL not saved (already processed or invalid)")

        elif "application/json" in content_type:  # Check JSON response
            # Skip redirect responses
            if 300 <= response.status < 400:
                return
            json_response = response.json()
            if isinstance(json_response, list) and json_response:
                for item in json_response:
                    if item.get("audioPlayable", False):
                        print(f"   🔍 Playable audio confirmed in JSON")

    except Exception as e:
        # Skip redirect errors - they're harmless
        if "redirect" not in str(e).lower():
            print(f"   ⚠️ Error processing response: {e}")

def find_all_activities(page):
    """Find all activity containers on the page"""
    selectors = [
        "div.apd-content-box.with-activity-page",
        ".apd-content-box.with-activity-page", 
        "[class*='apd-content-box']"
    ]
    
    for selector in selectors:
        try:
            activities = page.locator(selector)
            count = activities.count()
            if count > 0:
                return activities
        except:
            continue
    
    return None

def extract_single_transcript(activity, activity_num):
    """Extract transcript from a single activity"""
    try:
        # Get the text content
        text = activity.inner_text()
        
        if text.strip():  # Only process non-empty text
            # Clean up the text
            formatted_text = re.sub(r'(?<=[A-Za-z])(?=\d)', " ", text)
            formatted_text = re.sub(r'(?<=[ap]m)(?=[A-Za-z])', " ", formatted_text, flags=re.IGNORECASE)
            formatted_text = re.sub(r'\n+', '\n', formatted_text)  # Remove extra newlines
            formatted_text = formatted_text.strip()
            
            # Create the formatted output for transcript file
            transcript_data = f"--- Activity {activity_num} ---\n{formatted_text}\n"
            print(f"      ✅ Extracted transcript from activity {activity_num}")
            return transcript_data
        else:
            print(f"      ⚠️ No text found in activity {activity_num}")
            return f"--- Activity {activity_num} [No text content] ---\n"
            
    except Exception as e:
        print(f"      ❌ Error extracting transcript from activity {activity_num}: {e}")
        return f"--- Activity {activity_num} [Error: {e}] ---\n"

def process_single_activity_combined(activity, activity_num, total_activities):
    """Process a single activity - extract transcript first, then trigger audio"""
    print(f"   📋 Processing activity {activity_num}/{total_activities}")
    
    # Record current state before processing (for audio tracking)
    saved_before = len(PROCESSED_URLS)
    
    # Extract transcript first (before any interaction that might change DOM)
    print("      📝 Extracting transcript...")
    transcript_data = extract_single_transcript(activity, activity_num)
    ALL_TRANSCRIPTS.append(transcript_data)
    
    # Try to find and click expand button
    expand_buttons = [
        "button.apd-expand-toggle-button",
        "button.button-clear.fa.fa-chevron-down",
        "button[aria-label*='expand']"
    ]
    
    for btn_selector in expand_buttons:
        if activity.locator(btn_selector).count() > 0:
            try:
                activity.locator(btn_selector).first.click()
                time.sleep(1)
                print("      ➕ Expanded activity")
                break
            except Exception as e:
                continue

    # Try to find and click play button to trigger audio download
    play_buttons = [
        "button.play-audio-button",
        "button[aria-label*='play']",
        "button[aria-label*='audio']"
    ]
    
    for play_selector in play_buttons:
        if activity.locator(play_selector).count() > 0:
            try:
                print("      🎵 Clicking play button...")
                activity.locator(play_selector).first.click()
                time.sleep(3)  # Wait for audio to be detected
                break
            except Exception as e:
                continue
    
    # Check what audio URLs were saved during this activity
    saved_after = len(PROCESSED_URLS)
    new_saved = saved_after - saved_before
    
    # Show results for this activity
    if new_saved > 0:
        print(f"      ✅ Saved {new_saved} new audio URL(s)")
    else:
        print("      ⚠️ No new audio URLs saved")
    
    return True

def initialize_output_files(clear_existing=False):
    """Initialize all output files"""
    # Create backend directory if it doesn't exist
    os.makedirs(os.path.dirname(AUDIO_URLS_FILE), exist_ok=True)
    
    # Initialize audio URLs file
    if clear_existing or not os.path.exists(AUDIO_URLS_FILE):
        with open(AUDIO_URLS_FILE, "w") as f:
            json.dump([], f, indent=2)
        print("   📁 Created new/cleared audio URLs file")
        PROCESSED_URLS.clear()
    else:
        try:
            with open(AUDIO_URLS_FILE, "r") as f:
                existing = json.load(f)
            print(f"   📁 Existing audio URLs file loaded with {len(existing)} URLs")
            # Add existing URLs to processed set to avoid duplicates
            for url in existing:
                PROCESSED_URLS.add(url)
        except (json.JSONDecodeError, Exception) as e:
            # If file is corrupted, reset it
            with open(AUDIO_URLS_FILE, "w") as f:
                json.dump([], f, indent=2)
            print(f"   🔄 Reset corrupted audio URLs file: {e}")
    
    # Clear transcripts list
    ALL_TRANSCRIPTS.clear()

def scroll_to_load_more(page):
    """Scroll to bottom to load more activities"""
    print("   ⬇️  Scrolling to load more activities...")
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    time.sleep(3)  # Wait for new content to load

def continuous_load_and_process_combined(page):
    """Continuously load and process activities in batches - combined audio and transcripts"""
    print("🔄 Starting continuous loading and processing (audio + transcripts)...")
    
    total_processed = 0
    batch_count = 0
    max_batches = 10  # Safety limit
    
    while batch_count < max_batches:
        batch_count += 1
        print(f"\n📦 Processing Batch {batch_count}")
        
        # Find current activities
        activities = find_all_activities(page)
        if not activities:
            print("   ⚠️ No activities found")
            break
            
        current_activity_count = activities.count()
        print(f"   📊 Found {current_activity_count} activities")
        
        # Process activities in current view (start from where we left off)
        start_index = total_processed
        end_index = min(current_activity_count, start_index + 10)  # Process up to 10 new ones
        
        if start_index >= current_activity_count:
            print("   ⏸️  No new activities to process in this batch")
        else:
            print(f"   🔄 Processing activities {start_index + 1} to {end_index}")
            
            for i in range(start_index, end_index):
                try:
                    activity = activities.nth(i)
                    process_single_activity_combined(activity, i + 1, current_activity_count)
                    total_processed += 1
                except Exception as e:
                    print(f"   ❌ Error processing activity {i + 1}: {e}")
                    # Add error entry to transcripts
                    ALL_TRANSCRIPTS.append(f"--- Activity {i + 1} [Error: {e}] ---\n")
                    total_processed += 1
                    continue
        
        print(f"   ✅ Processed {end_index - start_index} activities in this batch")
        print(f"   📈 Total processed so far: {total_processed}")
        
        # Always scroll after each batch to try to load more
        scroll_to_load_more(page)
        
        # Check if we have more activities after scrolling
        new_activities = find_all_activities(page)
        if new_activities:
            new_count = new_activities.count()
            print(f"   🔍 After scrolling: {new_count} activities found")
            
            if new_count <= current_activity_count:
                print("   🏁 No new activities loaded - we've reached the end!")
                break
            else:
                print(f"   🎯 Found {new_count - current_activity_count} new activities!")
        else:
            print("   🏁 No activities found after scrolling - we've reached the end!")
            break
    
    return total_processed

def save_final_outputs():
    """Save all final output files"""
    # Save transcripts to text file
    print("📝 Saving transcripts to text file...")
    with open(TRANSCRIPTS_FILE, "w", encoding="utf-8") as f:
        for transcript in ALL_TRANSCRIPTS:
            f.write(transcript + "\n")
    
    # Audio URLs are already saved incrementally during processing

# ========== MAIN EXECUTION ==========
print("🚀 Starting Combined Alexa Audio & Transcript Extraction")
print("=" * 50)
print("💡 COMBINED APPROACH: Extract audio and transcripts together!")
print("=" * 50)

with sync_playwright() as p:
    # Initialize all output files
    print("📁 Initializing output files...")
    initialize_output_files(clear_existing=True)

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
        print("❌ Cookies file not found. Please run the login script first.")
        exit(1)
    
    # Open a new page
    page = context.new_page()

    # Intercept network requests & responses
    page.route("**/*", intercept_request)
    page.on("response", intercept_response)

    print("🌐 Navigating to Alexa privacy page...")
    
    try:
        page.goto("https://www.amazon.in/alexa-privacy/apd/rvh", wait_until="domcontentloaded")
        print("✅ Page loaded successfully")
        
        # Wait for page to be interactive
        time.sleep(3)
        
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
    print("🔍 Checking for voice recordings...")
    no_records_selectors = [
        "text=No voice recordings found",
        "text=No activities found", 
        "text=No records found",
        "text=You haven't interacted with Alexa"
    ]
    
    no_records_found = False
    for selector in no_records_selectors:
        if page.locator(selector).count() > 0:
            print("✅ No voice records found. This is normal if you haven't used Alexa.")
            no_records_found = True
            break

    if no_records_found:
        print("📝 No data to extract. All output files have been cleared.")
        browser.close()
        exit(0)

    # Process all activities with continuous loading
    print("\n🎯 STARTING CONTINUOUS COMBINED PROCESSING")
    print("-" * 40)
    
    total_processed = continuous_load_and_process_combined(page)

    print(f"\n📊 PROCESSING COMPLETE")
    print("-" * 40)
    print(f"   • Total activities processed: {total_processed}")
    print(f"   • Total unique URLs processed: {len(PROCESSED_URLS)}")
    print(f"   • Transcripts extracted: {len(ALL_TRANSCRIPTS)}")

    # Final wait for any remaining audio URLs
    print("⏳ Finalizing: Waiting for any remaining audio URLs...")
    time.sleep(5)

    # Save all final outputs
    save_final_outputs()

    # Read final results for statistics
    with open(AUDIO_URLS_FILE, "r") as f:
        final_audio_urls = json.load(f)

    # Calculate statistics
    audio_extracted_count = len(final_audio_urls)
    transcript_extracted_count = len(ALL_TRANSCRIPTS)

    print(f"\n✅ EXTRACTION COMPLETE!")
    print("=" * 50)
    print(f"📊 FINAL STATISTICS:")
    print(f"   • Total activities processed: {total_processed}")
    print(f"   • Unique audio URLs saved: {audio_extracted_count}")
    print(f"   • Transcripts extracted: {transcript_extracted_count}")
    
    # Calculate extraction rates
    if total_processed > 0:
        audio_rate = (audio_extracted_count / total_processed) * 100
        transcript_rate = (transcript_extracted_count / total_processed) * 100
        print(f"   • Audio extraction rate: {audio_rate:.1f}%")
        print(f"   • Transcript extraction rate: {transcript_rate:.1f}%")
    
    print(f"\n💾 OUTPUT FILES:")
    print(f"   • Audio URLs: {AUDIO_URLS_FILE}")
    print(f"   • Transcripts: {TRANSCRIPTS_FILE}")
    print("=" * 50)

    # Close browser
    print("🔄 Closing browser...")
    browser.close()