import os
import json
import re
import time
from playwright.sync_api import sync_playwright

output_file = "alexa_activity_log.txt"

def find_all_activities(page):
    """Find all activity containers on the page - same as audio extraction"""
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

def scroll_to_load_more(page):
    """Scroll to bottom to load more activities with better waiting"""
    print("   ⬇️  Scrolling to load more activities...")
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    time.sleep(4)  # Increased wait time for better loading

def continuous_load_and_extract_transcripts(page):
    """Continuously load and extract transcripts in batches - improved logic"""
    print("🔄 Starting continuous loading and transcript extraction...")
    
    all_transcripts = []
    total_processed = 0
    batch_count = 0
    max_batches = 20  # Increased safety limit
    
    # First, let's try to load all activities by scrolling multiple times
    print("📥 Pre-loading all activities by scrolling...")
    for i in range(3):  # Try scrolling 3 times to load everything
        scroll_to_load_more(page)
        activities = find_all_activities(page)
        if activities:
            print(f"   📊 After scroll {i+1}: {activities.count()} activities found")
    
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
        
        # Check if we've already processed all current activities
        if total_processed >= current_activity_count:
            print("   🔄 All current activities processed, scrolling for more...")
            previous_count = current_activity_count
            scroll_to_load_more(page)
            
            # Check if we got more activities after scrolling
            new_activities = find_all_activities(page)
            if new_activities:
                new_count = new_activities.count()
                if new_count > previous_count:
                    print(f"   🎯 Found {new_count - previous_count} new activities after scrolling!")
                    continue  # Continue to process the new batch
                else:
                    print("   🏁 No more activities to load - we've reached the end!")
                    break
            else:
                print("   🏁 No activities found after scrolling - we've reached the end!")
                break
        
        # Process activities in current view (start from where we left off)
        start_index = total_processed
        end_index = min(current_activity_count, start_index + 10)  # Process up to 10 new ones
        
        print(f"   🔄 Extracting transcripts from activities {start_index + 1} to {end_index}")
        
        new_transcripts_in_batch = 0
        for i in range(start_index, end_index):
            try:
                activity = activities.nth(i)
                transcript_data = extract_single_transcript(activity, i + 1, current_activity_count)
                if transcript_data:
                    all_transcripts.append(transcript_data)
                    new_transcripts_in_batch += 1
                total_processed += 1
            except Exception as e:
                print(f"   ❌ Error extracting transcript from activity {i + 1}: {e}")
                # Add error placeholder
                all_transcripts.append(f"--- Activity {i + 1} [Error: {e}] ---\n")
                total_processed += 1
                continue
        
        print(f"   ✅ Processed {new_transcripts_in_batch} new transcripts in this batch")
        print(f"   📈 Total processed so far: {total_processed}")
        
        # Always scroll after each batch to try to load more
        scroll_to_load_more(page)
    
    return all_transcripts, total_processed

def extract_single_transcript(activity, activity_num, total_activities):
    """Extract transcript from a single activity"""
    print(f"   📋 Extracting transcript from activity {activity_num}/{total_activities}")
    
    try:
        # Get the text content
        text = activity.inner_text()
        
        if text.strip():  # Only process non-empty text
            # Clean up the text
            formatted_text = re.sub(r'(?<=[A-Za-z])(?=\d)', " ", text)
            formatted_text = re.sub(r'(?<=[ap]m)(?=[A-Za-z])', " ", formatted_text, flags=re.IGNORECASE)
            formatted_text = re.sub(r'\n+', '\n', formatted_text)  # Remove extra newlines
            formatted_text = formatted_text.strip()
            
            # Create the formatted output
            transcript_data = f"--- Activity {activity_num} ---\n{formatted_text}\n"
            print(f"      ✅ Extracted transcript from activity {activity_num}")
            return transcript_data
        else:
            print(f"      ⚠️ No text found in activity {activity_num}")
            return f"--- Activity {activity_num} [No text content] ---\n"
            
    except Exception as e:
        print(f"      ❌ Error extracting transcript from activity {activity_num}: {e}")
        return f"--- Activity {activity_num} [Error: {e}] ---\n"

def extract_alexa_transcripts():
    with sync_playwright() as p:
        # Launch the browser
        browser = p.chromium.launch(headless=False)
        
        # Create a new context where we'll add the cookies
        context = browser.new_context()
        
        # Load cookies from the file
        cookies_path = "backend/cookies.json"
        if not os.path.exists(cookies_path):
            print("❌ Cookies file not found. Please run the login script first.")
            return False
            
        try:
            with open(cookies_path, "r") as f:
                cookies = json.load(f)
            # Add cookies to the context
            context.add_cookies(cookies)
            print("✅ Cookies loaded successfully")
        except Exception as e:
            print(f"❌ Error loading cookies: {e}")
            browser.close()
            return False
        
        # Open a new page using the context with loaded cookies
        page = context.new_page()
        
        try:
            print("🌐 Navigating to Alexa privacy page...")
            page.goto("https://www.amazon.in/alexa-privacy/apd/rvh", wait_until="domcontentloaded")
            
            # Wait for page to be interactive
            time.sleep(3)
            
            # Check if we're actually logged in
            if "signin" in page.url or page.locator("input#ap_email").count() > 0:
                print("❌ Not logged in. Please check your cookies.")
                browser.close()
                return False
            
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
                with open(output_file, "w", encoding="utf-8") as f:
                    f.write("No Alexa voice records found.\n")
                print(f"📝 Created empty activity log at {output_file}")
                browser.close()
                return True

            # Use continuous loading to extract all transcripts
            print("\n🎯 STARTING CONTINUOUS TRANSCRIPT EXTRACTION")
            print("-" * 40)
            
            all_transcripts, total_processed = continuous_load_and_extract_transcripts(page)

            # Write all transcripts to file
            print(f"\n📝 Writing {len(all_transcripts)} transcripts to file...")
            with open(output_file, "w", encoding="utf-8") as f:
                if all_transcripts:
                    for transcript in all_transcripts:
                        f.write(transcript + "\n")
                    print(f"✅ Successfully extracted {len(all_transcripts)} transcripts to {output_file}")
                else:
                    f.write("No transcripts found.\n")
                    print("⚠️ No transcripts were extracted")
            
            print(f"\n📊 EXTRACTION COMPLETE")
            print("-" * 40)
            print(f"   • Total activities processed: {total_processed}")
            print(f"   • Transcripts extracted: {len(all_transcripts)}")
            
        except Exception as e:
            print(f"❌ Error during extraction: {e}")
            # Save error information
            with open(output_file, "w", encoding="utf-8") as f:
                f.write(f"Error extracting Alexa activities: {e}\n")
            return False
        
        finally:
            browser.close()
    
    return True

if __name__ == "__main__":
    print("🚀 Starting Alexa Transcript Extraction")
    print("=" * 50)
    print("💡 IMPROVED CONTINUOUS LOADING: Better scrolling and detection!")
    print("=" * 50)
    
    success = extract_alexa_transcripts()
    if success:
        print(f"\n✅ EXTRACTION COMPLETE!")
        print("=" * 50)
        print(f"📄 Transcripts saved to: {output_file}")
        print("=" * 50)
    else:
        print("💥 Alexa transcript extraction failed.")