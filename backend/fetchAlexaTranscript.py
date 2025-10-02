import os
import json
import re
from playwright.sync_api import sync_playwright

output_file = "alexa_activity_log.txt"

def extract_alexa_transcripts():
    with sync_playwright() as p:
        # Launch the browser
        browser = p.chromium.launch(headless=True)
        
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
            
            # Wait a bit for content to load
            page.wait_for_timeout(5000)
            
            # Check if we're actually logged in
            if "signin" in page.url or page.locator("input#ap_email").count() > 0:
                print("❌ Not logged in. Please check your cookies.")
                browser.close()
                return False
            
            # Check for "no records" scenario
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
                    print("✅ No voice records found on the page.")
                    no_records_found = True
                    break
            
            if no_records_found:
                with open(output_file, "w", encoding="utf-8") as f:
                    f.write("No Alexa voice records found.\n")
                print(f"📝 Created empty activity log at {output_file}")
                browser.close()
                return True
            
            # Try multiple selectors for activity containers
            activity_selectors = [
                "div.apd-content-box.with-activity-page",
                ".activity-container",
                "[data-testid*='activity']",
                ".voice-record-item",
                "div[class*='activity']",
                ".record-item"
            ]
            
            activities = None
            found_selector = None
            
            for selector in activity_selectors:
                try:
                    # Wait for any of the selectors to appear
                    page.wait_for_selector(selector, timeout=10000)
                    elements = page.query_selector_all(selector)
                    if len(elements) > 0:
                        activities = elements
                        found_selector = selector
                        print(f"✅ Found {len(activities)} activities using selector: {selector}")
                        break
                except:
                    continue
            
            if not activities:
                print("❌ No activity containers found. Possible reasons:")
                print("   - No voice records available")
                print("   - Page structure has changed")
                print("   - Different regional website layout")
                
                # Try to get any text content that might be available
                page_content = page.content()
                if "alexa" in page_content.lower() or "voice" in page_content.lower():
                    print("ℹ️  Alexa-related content detected but no structured activities found")
                
                # Save a basic message
                with open(output_file, "w", encoding="utf-8") as f:
                    f.write("No structured voice activities found on the page.\n")
                
                browser.close()
                return True
            
            # Extract and process the activities
            print(f"📝 Extracting text from {len(activities)} activities...")
            
            with open(output_file, "w", encoding="utf-8") as f:
                for i, activity in enumerate(activities):
                    try:
                        text = activity.inner_text()
                        if text.strip():  # Only process non-empty text
                            # Clean up the text
                            formatted_text = re.sub(r'(?<=[A-Za-z])(?=\d)', " ", text)
                            formatted_text = re.sub(r'(?<=[ap]m)(?=[A-Za-z])', " ", formatted_text, flags=re.IGNORECASE)
                            formatted_text = re.sub(r'\n+', '\n', formatted_text)  # Remove extra newlines
                            formatted_text = formatted_text.strip()
                            
                            f.write(f"--- Activity {i+1} ---\n")
                            f.write(formatted_text + "\n\n")
                            print(f"✅ Extracted activity {i+1}")
                    except Exception as e:
                        print(f"⚠️  Error extracting activity {i+1}: {e}")
                        f.write(f"--- Activity {i+1} [Error: {e}] ---\n\n")
            
            print(f"✅ Successfully extracted {len(activities)} activities to {output_file}")
            
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
    success = extract_alexa_transcripts()
    if success:
        print(f"🎉 Alexa activity extraction completed. Check {output_file}")
    else:
        print("💥 Alexa activity extraction failed.")