import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from selenium.webdriver.common.keys import Keys
import json
import os
import time
import base64
import hashlib
import sys
from dotenv import load_dotenv
import requests  # NEW: Added for HTTP communication

# Load environment variables
load_dotenv()

# Get credentials from environment variables
AMAZON_EMAIL = os.getenv('AMAZON_EMAIL')
AMAZON_PASSWORD = os.getenv('AMAZON_PASSWORD')

if not AMAZON_EMAIL or not AMAZON_PASSWORD:
    print('Error: Please set AMAZON_EMAIL and AMAZON_PASSWORD environment variables.')
    sys.exit(1)

# NEW: Real-time server communication functions
def update_server_status(method=None, message=None, current_url=None, error_type=None, otp_error=None, show_otp_modal=None):
    """Send real-time status updates to the Node.js server"""
    request_id = os.environ.get('REQUEST_ID')
    if not request_id:
        print(f"⚠️ No REQUEST_ID found, skipping server update: {message}")
        return
    
    try:
        payload = {}
        if method is not None:
            payload['method'] = method
        if message is not None:
            payload['message'] = message
        if current_url is not None:
            payload['currentUrl'] = current_url
        if error_type is not None:
            payload['errorType'] = error_type
        if otp_error is not None:
            payload['otpError'] = otp_error
        if show_otp_modal is not None:
            payload['showOtpModal'] = show_otp_modal
        
        response = requests.post(
            f'http://localhost:5000/api/internal/2fa-update/{request_id}',
            json=payload,
            timeout=5
        )
        if response.status_code == 200:
            print(f"✅ Status update sent to server: {message}")
        else:
            print(f"⚠️ Failed to send status update: {response.status_code}")
    except Exception as e:
        print(f"⚠️ Could not connect to server: {e}")

def get_otp_from_server():
    """Poll server for OTP input from frontend"""
    request_id = os.environ.get('REQUEST_ID')
    if not request_id:
        return None
    
    try:
        response = requests.get(
            f'http://localhost:5000/api/internal/get-otp/{request_id}',
            timeout=5
        )
        if response.status_code == 200:
            data = response.json()
            return data.get('otp')
    except Exception as e:
        print(f"⚠️ Could not get OTP from server: {e}")
    
    return None

def clear_otp_from_server():
    """Clear OTP from server after use"""
    request_id = os.environ.get('REQUEST_ID')
    if not request_id:
        return
    
    try:
        requests.post(
            f'http://localhost:5000/api/internal/clear-otp/{request_id}',
            timeout=3
        )
    except Exception as e:
        print(f"⚠️ Could not clear OTP from server: {e}")

# Generate a unique hash for current credentials
def generate_credentials_hash(email, password):
    return hashlib.sha256(f"{email}:{password}".encode()).hexdigest()[:16]

current_credentials_hash = generate_credentials_hash(AMAZON_EMAIL, AMAZON_PASSWORD)

# URLs for Amazon homepage and Alexa activity page
activity_url = 'https://www.amazon.in/alexa-privacy/apd/rvh'

def is_manual_mode():
    """Check if we're running in manual mode (no frontend pipeline)"""
    return 'REQUEST_ID' not in os.environ

def get_manual_otp():
    """Get manual OTP input from user"""
    print('\n🔢 Enter OTP code manually (or press Enter to skip and wait for auto-redirect): ', end='')
    otp = input().strip()
    return otp

def is_on_target_page(driver):
    """Check if we're on target page"""
    try:
        return '/alexa-privacy/apd/' in driver.current_url
    except:
        return False

def is_on_push_notification_page(driver):
    """Enhanced function to detect push notification page"""
    try:
        current_url = driver.current_url
        page_source = driver.page_source.lower()
        
        # Check for push notification page indicators
        push_indicators = [
            '/ap/cv/' in current_url,
            'transactionapprox' in current_url,
            'approve the notification' in page_source,
            'sent to:' in page_source,
            'amazonshopping' in page_source,
            'check your device' in page_source
        ]
        
        return any(push_indicators)
    except:
        return False

def detect_2fa_method(driver):
    """Enhanced 2FA method detection"""
    try:
        print('🔍 Detecting 2FA method...')
        
        current_url = driver.current_url
        
        # Check for OTP FIRST
        otp_selectors = [
            '#auth-mfa-otpcode',
            'input[name="otpCode"]',
            'input[name="code"]',
            'input[type="tel"]',
            'input[inputmode="numeric"]',
            'input[placeholder*="code"]',
            'input[placeholder*="otp"]'
        ]
        
        # Check OTP indicators first
        for selector in otp_selectors:
            try:
                elements = driver.find_elements(By.CSS_SELECTOR, selector)
                if elements:
                    print('✅ Detected OTP 2FA method')
                    return 'OTP (SMS/Voice)'
            except:
                continue
        
        # Only AFTER checking OTP, check for push notification
        if is_on_push_notification_page(driver):
            print('✅ Detected Push Notification 2FA method')
            return 'Push Notification'
        
        return 'Unknown 2FA Method'
    except Exception as error:
        print(f'Error detecting 2FA method: {error}')
        return 'Error detecting 2FA method'

def is_on_2fa_page(driver):
    """Check if we're on any kind of 2FA page"""
    try:
        # Check for OTP input fields FIRST
        otp_input_selectors = [
            '#auth-mfa-otpcode',
            'input[name="otpCode"]',
            'input[name="code"]',
            'input[type="tel"]',
            'input[inputmode="numeric"]'
        ]
        
        for selector in otp_input_selectors:
            try:
                elements = driver.find_elements(By.CSS_SELECTOR, selector)
                if elements:
                    return True
            except:
                continue
        
        # Only AFTER checking OTP, check for push notification page
        if is_on_push_notification_page(driver):
            return True
        
        current_url = driver.current_url
        
        # Check for 2FA text indicators
        otp_indicators = [
            'two-step verification',
            'two-factor authentication', 
            'verification code',
            'enter code'
        ]
        
        page_text = driver.page_source.lower()
        for indicator in otp_indicators:
            if indicator in page_text:
                return True
        
        return '/ap/' in current_url and (
            'mfa' in current_url or 
            'otp' in current_url or 
            'verify' in current_url
        )
        
    except:
        return False

def is_unknown_2fa_page(driver):
    """Detect unknown 2FA page (not OTP or Push)"""
    try:
        print('🔍 Checking for unknown 2FA page...')
        
        # If we're on target page, it's not unknown
        if is_on_target_page(driver):
            return False
        
        # If we're on known 2FA pages (OTP or Push), it's not unknown
        if is_on_2fa_page(driver):
            method = detect_2fa_method(driver)
            if method in ['OTP (SMS/Voice)', 'Push Notification']:
                return False
        
        # Check if we're on any Amazon authentication page that's not the target page
        current_url = driver.current_url
        if '/ap/' in current_url and '/alexa-privacy/apd/' not in current_url and not is_on_target_page(driver):
            print(f'🔴 Detected unknown 2FA/Auth page: {current_url}')
            return True
        
        return False
    except Exception as error:
        print(f'Error checking for unknown 2FA page: {error}')
        return False

def is_invalid_email_error(driver):
    """Detect invalid email error"""
    try:
        error_selectors = [
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'we cannot find an account with that email')]",
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'no account found')]",
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'invalid email')]",
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'account not found')]",
            '.a-box-inner.a-alert-container',
            '.a-alert-content'
        ]
        
        for selector in error_selectors:
            try:
                if selector.startswith('//'):
                    elements = driver.find_elements(By.XPATH, selector)
                else:
                    elements = driver.find_elements(By.CSS_SELECTOR, selector)
                
                for element in elements:
                    text = element.text.lower()
                    if 'cannot find an account' in text or 'no account found' in text:
                        return True
            except:
                continue
        
        # Also check page source as fallback
        page_source = driver.page_source.lower()
        if 'cannot find an account' in page_source or 'no account found' in page_source:
            return True
        
        return False
    except:
        return False

def is_incorrect_password_error(driver):
    """Detect incorrect password error"""
    try:
        error_selectors = [
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'your password is incorrect')]",
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'incorrect password')]",
            "//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'wrong password')]",
            '.a-box-inner.a-alert-container',
            '.a-alert-content',
            '.a-list-item'
        ]
        
        for selector in error_selectors:
            try:
                if selector.startswith('//'):
                    elements = driver.find_elements(By.XPATH, selector)
                else:
                    elements = driver.find_elements(By.CSS_SELECTOR, selector)
                
                for element in elements:
                    text = element.text.lower()
                    if 'password is incorrect' in text or 'incorrect password' in text:
                        return True
            except:
                continue
        
        # Also check page source as fallback
        page_source = driver.page_source.lower()
        if 'password is incorrect' in page_source or 'incorrect password' in page_source:
            return True
        
        return False
    except:
        return False

def check_for_auth_errors(driver, context='general'):
    """Check for authentication errors - IMPROVED"""
    print(f'🔍 Checking for authentication errors (context: {context})...')
    
    # Check for invalid email error
    if is_invalid_email_error(driver):
        print('❌ AUTHENTICATION ERROR: Invalid email address')
        print(f'   The email "{AMAZON_EMAIL}" is not associated with an Amazon account')
        return 'INVALID_EMAIL'
    
    # Check for incorrect password error
    if is_incorrect_password_error(driver):
        print('❌ AUTHENTICATION ERROR: Incorrect password')
        print('   The password provided does not match the email address')
        return 'INCORRECT_PASSWORD'
    
    # NEW: Check for unknown 2FA page
    if is_unknown_2fa_page(driver):
        print('❌ UNKNOWN 2FA PAGE: Unsupported authentication method detected')
        print('   This account requires additional verification that cannot be automated')
        return 'UNKNOWN_2FA_PAGE'
    
    return None

def needs_full_login(driver):
    """Check if we need full login"""
    try:
        email_selectors = ['#ap_email', 'input[name="email"]', 'input[type="email"]', 'input#ap_email']
        for selector in email_selectors:
            try:
                elements = driver.find_elements(By.CSS_SELECTOR, selector)
                if elements:
                    return True
            except:
                continue
        
        url = driver.current_url
        if '/ap/signin' in url or '/ap/login' in url:
            return True
        
        return False
    except:
        return False

def is_true_re_auth_scenario(driver):
    """Check if this is a true re-authentication scenario"""
    try:
        pass_selectors = ['#ap_password', 'input[name="password"]', 'input[type="password"]']
        for selector in pass_selectors:
            try:
                elements = driver.find_elements(By.CSS_SELECTOR, selector)
                if elements:
                    return True
            except:
                continue
        
        url = driver.current_url
        if '/ap/re-auth' in url or '/ap/mfa/' in url:
            return True
        
        source = driver.page_source.lower()
        if source and any(phrase in source for phrase in ['re-auth', 'reauth', 'verify it\'s you', 'verify your identity']):
            return True
        
        return False
    except:
        return False

def fill_otp_and_submit(driver, otp):
    """Fill OTP and submit with REDIRECTION-BASED validation"""
    try:
        print(f'Attempting to auto-fill OTP (masked) ...')
        print(f'OTP (masked): {"*" * len(otp) if otp else ""}')

        otp_selectors = [
            '#auth-mfa-otpcode',
            'input[name="otpCode"]',
            'input[name="code"]',
            'input[placeholder*="code"]',
            'input[placeholder*="otp"]',
            'input[type="tel"]',
            'input[type="number"]',
            'input[inputmode="numeric"]'
        ]

        filled = False
        for selector in otp_selectors:
            try:
                element = driver.find_element(By.CSS_SELECTOR, selector)
                if element:
                    element.clear()
                    element.send_keys(otp)
                    filled = True
                    break
            except:
                continue

        if not filled:
            try:
                # Try XPath for text inputs with code/otp in placeholder
                xpath = "//input[@type='text' or @type='tel' or @type='number'][contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'code') or contains(translate(@placeholder,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'otp')]"
                elements = driver.find_elements(By.XPATH, xpath)
                if elements:
                    elements[0].clear()
                    elements[0].send_keys(otp)
                    filled = True
            except:
                pass

        if filled:
            # Get current URL before submission to detect redirection
            url_before_submit = driver.current_url
            
            # Small pause to allow page to react to typed input
            time.sleep(0.4)

            submit_selectors = [
                '#cvf-submit-otp-button span input',
                'input.a-button-input[type="submit"]',
                'button[type="submit"]',
                'input[type="submit"]'
            ]

            clicked = False
            for selector in submit_selectors:
                try:
                    element = driver.find_element(By.CSS_SELECTOR, selector)
                    if element:
                        element.click()
                        clicked = True
                        break
                except:
                    continue

            if not clicked:
                try:
                    # Try to find any element and send Enter key
                    from selenium.webdriver.common.keys import Keys
                    element = driver.switch_to.active_element
                    element.send_keys(Keys.RETURN)
                    clicked = True
                except:
                    pass

            if clicked:
                print('OTP auto-submitted.')
                
                # Wait for page to process the OTP - allow time for redirection
                time.sleep(5)
                
                # NEW LOGIC: Check current URL and page state after submission
                current_url = driver.current_url
                still_on_otp_page = is_on_2fa_page(driver)
                on_target_page = is_on_target_page(driver)
                
                print(f'🔄 Post-submission state check:')
                print(f'   - Still on OTP page: {still_on_otp_page}')
                print(f'   - On target page: {on_target_page}')
                print(f'   - URL changed: {current_url != url_before_submit}')
                
                # SUCCESS CASE: We're on the target page
                if on_target_page:
                    print('✅ OTP verification SUCCESSFUL - redirected to target page')
                    return True
                
                # FAILURE CASE: We're still on an OTP page
                if still_on_otp_page:
                    print('❌ OTP verification FAILED - redirected back to OTP page')
                    
                    # Additional check: If we're on a DIFFERENT OTP page than before, it's definitely a failure
                    if current_url != url_before_submit and '/ap/' in current_url:
                        print('🔴 Confirmed OTP failure - redirected to different authentication page')
                    
                    raise Exception('INVALID_OTP')
                
                # TRANSITION CASE: We're not on OTP page and not on target page - might be in transition
                print('🔄 OTP submitted, page is transitioning...')
                return False
            
            else:
                print('OTP filled but submit action failed.')
        else:
            print('Could not locate OTP input to fill.')
            
    except Exception as err:
        if 'INVALID_OTP' in str(err):
            raise Exception('INVALID_OTP')
        print(f'Error in fill_otp_and_submit: {err}')
    
    return False

def handle_manual_otp_mode(driver):
    """Handle manual OTP mode"""
    if not is_manual_mode():
        return None
    
    print('\n🔧 MANUAL MODE: Running without frontend pipeline')
    print('📝 You can manually enter OTP or wait for auto-redirect')
    
    otp = get_manual_otp()
    
    if otp and len(otp) == 6 and otp.isdigit():
        print(f'🔄 Attempting to submit manual OTP: {"*" * len(otp)}')
        try:
            success = fill_otp_and_submit(driver, otp)
            if success:
                print('✅ Manual OTP submission successful!')
                return True
        except Exception as error:
            if 'INVALID_OTP' in str(error):
                print('❌ Manual OTP verification failed')
                print('🔄 Please try again or wait for auto-redirect')
                return False
            raise error
    elif otp:
        print('❌ Invalid OTP format. Please enter exactly 6 digits.')
        return False
    else:
        print('⏳ Skipping manual OTP, waiting for auto-redirect...')
        return None

def handle_otp_authentication(driver, context='full_auth'):
    """Enhanced OTP handling with real-time server communication"""
    print(f'🔐 Handling OTP authentication ({context})...')
    
    attempts = 0
    max_otp_attempts = 10 if is_manual_mode() else 4
    
    start_time = time.time()
    
    while time.time() - start_time < 10 * 60 and attempts < max_otp_attempts:
        time.sleep(2)
        
        # Check if we're still on OTP page
        if not is_on_2fa_page(driver) and not is_on_target_page(driver):
            print('🔄 No longer on OTP page, checking authentication status...')
            time.sleep(5)
            if is_on_target_page(driver):
                print('✅ OTP authentication completed successfully!')
                update_server_status(
                    message='OTP verification successful!',
                    show_otp_modal=False
                )
                break
            continue
        
        # Get OTP from server in pipeline mode
        if not is_manual_mode():
            otp = get_otp_from_server()
            if otp:
                print(f'🔄 Attempting to submit OTP from server (masked): {"*" * len(otp)}')
                try:
                    success = fill_otp_and_submit(driver, otp)
                    if success:
                        print('✅ OTP submission successful!')
                        update_server_status(
                            message='OTP verification successful!',
                            show_otp_modal=False
                        )
                        clear_otp_from_server()
                        break
                    else:
                        print('❌ OTP submission failed')
                        attempts += 1
                        # Don't clear OTP yet - let frontend handle retry
                        continue
                except Exception as error:
                    if 'INVALID_OTP' in str(error):
                        print('❌ OTP verification failed')
                        update_server_status(
                            message='OTP verification failed',
                            error_type='INVALID_OTP',
                            otp_error='The code you entered is not valid. Please check the code and try again.',
                            show_otp_modal=True
                        )
                        clear_otp_from_server()
                        attempts += 1
                        # Wait for new OTP from frontend
                        continue
                    raise error
        else:
            # Manual mode handling (existing code)
            manual_result = handle_manual_otp_mode(driver)
            if manual_result is True:
                print('✅ Manual OTP authentication completed')
                update_server_status(message='Manual OTP authentication completed', show_otp_modal=False)
                break
            elif manual_result is False:
                attempts += 1
                continue
        
        # In manual mode, check for automatic redirection
        if is_manual_mode() and is_on_target_page(driver):
            print('✅ Automatic redirection detected! OTP no longer needed.')
            update_server_status(message='Automatic authentication detected', show_otp_modal=False)
            break
    
    if attempts >= max_otp_attempts:
        update_server_status(
            message='Maximum OTP attempts exceeded',
            error_type='GENERIC_ERROR'
        )
        raise Exception('Maximum OTP attempts exceeded')
    
    # Final redirection check
    if not is_on_target_page(driver):
        print('🔄 Waiting for final redirection after OTP...')
        update_server_status(message='Waiting for final authentication...')
        success = wait_for_redirect_after_2fa(driver)
        if not success:
            update_server_status(
                message='Failed to complete authentication after OTP',
                error_type='GENERIC_ERROR'
            )
            raise Exception('Failed to complete OTP redirection')

def wait_for_redirect_after_2fa(driver, timeout=180):
    """Enhanced wait function with better push notification handling and cleanup"""
    print('⏳ Waiting for automatic redirection to activity page after 2FA...')
    
    start_time = time.time()
    last_state = '2fa_page'
    was_on_push_page = False
    
    try:
        while time.time() - start_time < timeout:
            try:
                current_url = driver.current_url
                
                # Check if we're on target page
                if is_on_target_page(driver):
                    print('✅ Automatic redirection detected! Now on target page.')
                    return True
                
                # Check if we're on push notification page
                on_push_page = is_on_push_notification_page(driver)
                if on_push_page:
                    was_on_push_page = True
                
                # Check if we're on any 2FA page
                on_2fa_page = is_on_2fa_page(driver)
                
                # Check if we're back on login page (error condition) - push notification failure
                on_login_page = needs_full_login(driver)
                
                # NEW: Detect push notification failure - THROW ERROR INSTEAD OF RETURNING
                if was_on_push_page and on_login_page and not on_2fa_page and not on_push_page:
                    print('❌ Push notification was denied or failed')
                    update_server_status(
                        message='Push notification was denied',
                        error_type='PUSH_DENIED'
                    )
                    raise Exception('PUSH_NOTIFICATION_DENIED')
                
                if on_push_page:
                    if last_state != 'push_page':
                        print('📱 On push notification page - waiting for user to approve on device...')
                        update_server_status(message='Push notification sent to your device. Please approve to continue...')
                        last_state = 'push_page'
                    # Stay on push notification page and wait
                    time.sleep(5)
                    continue
                
                if on_2fa_page:
                    if last_state != '2fa_page':
                        print('🔐 Still on 2FA page, waiting...')
                        update_server_status(message='Still on 2FA page, waiting...')
                        last_state = '2fa_page'
                    time.sleep(3)
                    continue
                
                # If we're not on 2FA page and not on target page, we might be in transition
                if not on_2fa_page and not on_push_page:
                    if last_state != 'transition':
                        print('🔄 2FA completed, waiting for final redirection...')
                        update_server_status(message='2FA completed, waiting for final redirection...')
                        last_state = 'transition'
                    time.sleep(2)
                    continue
                
            except Exception as error:
                if 'PUSH_NOTIFICATION_DENIED' in str(error):
                    print('🔄 Propagating PUSH_NOTIFICATION_DENIED error to main flow...')
                    raise error  # Re-throw to break out of function entirely
                # If there's an error checking the page, wait and continue
                print('⚠️ Error checking page state, continuing to wait...')
                time.sleep(5)
        
        print('❌ Timeout waiting for automatic redirection after 2FA')
        return False
    except Exception as error:
        # Ensure any errors in this function are properly propagated
        if 'PUSH_NOTIFICATION_DENIED' in str(error):
            raise error  # Re-throw push denial errors
        print(f'Error in wait_for_redirect_after_2FA: {error}')
        raise error

def perform_full_authentication(driver):
    """Perform full authentication with real-time server updates"""
    try:
        print('Starting full authentication process...')
        update_server_status(message='Starting authentication process...')
        
        if is_manual_mode():
            print('🔧 MANUAL MODE: You may need to complete authentication steps in the browser')
            update_server_status(message='Manual mode detected - complete authentication in browser')

        # Email step
        email_filled = False
        try:
            email_selectors = ['#ap_email', 'input[name="email"]', 'input[type="email"]']
            for selector in email_selectors:
                try:
                    element = driver.find_element(By.CSS_SELECTOR, selector)
                    if element:
                        element.clear()
                        element.send_keys(AMAZON_EMAIL)
                        email_filled = True
                        update_server_status(message='Email entered successfully')
                        
                        continue_selectors = ['input#continue', 'button#continue', 'input[name="continue"]']
                        for cont_sel in continue_selectors:
                            try:
                                cont_element = driver.find_element(By.CSS_SELECTOR, cont_sel)
                                if cont_element:
                                    cont_element.click()
                                    time.sleep(2)
                                    break
                            except:
                                continue
                        break
                except:
                    continue
        except Exception as e:
            print(f'❌ Email fill failed: {e}')
            update_server_status(message='Email entry failed', error_type='GENERIC_ERROR')

        if not email_filled:
            print('⚠️ Could not find email field, checking if already on password page...')
            update_server_status(message='Checking authentication state...')

        time.sleep(2)
        update_server_status(current_url=driver.current_url)

        # Check for email errors
        email_error = check_for_auth_errors(driver)
        if email_error == 'INVALID_EMAIL':
            update_server_status(
                message='The email address is not associated with an Amazon account',
                error_type='INVALID_EMAIL'
            )
            raise Exception('INVALID_EMAIL')
        
        # Password step
        password_filled = False
        try:
            pass_selectors = ['#ap_password', 'input[name="password"]', 'input[type="password"]']
            for selector in pass_selectors:
                try:
                    element = driver.find_element(By.CSS_SELECTOR, selector)
                    if element:
                        element.clear()
                        element.send_keys(AMAZON_PASSWORD)
                        password_filled = True
                        update_server_status(message='Password entered successfully')
                        
                        sign_selectors = ['input#signInSubmit', 'button#signInSubmit', 'button[name="signIn"]', 'input[type="submit"]']
                        for sign_sel in sign_selectors:
                            try:
                                sign_element = driver.find_element(By.CSS_SELECTOR, sign_sel)
                                if sign_element:
                                    sign_element.click()
                                    update_server_status(message='Submitting credentials...')
                                    break
                            except:
                                continue
                        break
                except:
                    continue
        except Exception as e:
            print(f'❌ Password fill failed: {e}')
            update_server_status(message='Password entry failed', error_type='GENERIC_ERROR')

        if not password_filled:
            print('⚠️ Could not find password field, checking current authentication state...')
            update_server_status(message='Checking password authentication state...')

        time.sleep(3)
        update_server_status(current_url=driver.current_url)

        # Check for authentication errors
        auth_error = check_for_auth_errors(driver)
        if auth_error == 'INVALID_EMAIL':
            update_server_status(
                message='The email address is not associated with an Amazon account',
                error_type='INVALID_EMAIL'
            )
            raise Exception('INVALID_EMAIL')
        elif auth_error == 'INCORRECT_PASSWORD':
            update_server_status(
                message='The password is incorrect',
                error_type='INCORRECT_PASSWORD'
            )
            raise Exception('INCORRECT_PASSWORD')
        elif auth_error == 'UNKNOWN_2FA_PAGE':
            update_server_status(
                message='This account requires additional verification that cannot be automated',
                error_type='UNKNOWN_2FA_PAGE'
            )
            raise Exception('UNKNOWN_2FA_PAGE')
        
        # Handle 2FA
        if is_on_2fa_page(driver):
            method = detect_2fa_method(driver)
            print(f'🔐 2FA detected -> {method}')
            update_server_status(
                method=method,
                message=f'Two-factor authentication required: {method}',
                current_url=driver.current_url,
                show_otp_modal=(method and 'otp' in method.lower())
            )
            
            if is_unknown_2fa_page(driver):
                update_server_status(
                    message='This account requires additional verification that cannot be automated',
                    error_type='UNKNOWN_2FA_PAGE'
                )
                raise Exception('UNKNOWN_2FA_PAGE')
            
            if method and 'otp' in method.lower():
                print('📱 OTP authentication required')
                update_server_status(message='Waiting for OTP input...', show_otp_modal=True)
                handle_otp_authentication(driver, 'full_auth')
            else:
                print('📲 Push notification authentication required')
                update_server_status(message='Push notification sent to your device. Please approve to continue...')
                try:
                    success = wait_for_redirect_after_2fa(driver)
                    if not success:
                        update_server_status(
                            message='Push notification approval failed or timed out',
                            error_type='PUSH_DENIED'
                        )
                        raise Exception('Push notification approval failed or timed out')
                except Exception as error:
                    if 'PUSH_NOTIFICATION_DENIED' in str(error):
                        update_server_status(
                            message='Push notification was denied',
                            error_type='PUSH_DENIED'
                        )
                        raise error
                    update_server_status(
                        message='Push notification approval failed',
                        error_type='GENERIC_ERROR'
                    )
                    raise Exception('Push notification approval failed or timed out')
        else:
            print('✅ No 2FA required, proceeding with standard authentication...')
            update_server_status(message='No 2FA required, proceeding...')

        on_target = is_on_target_page(driver)
        if not on_target:
            print(f'❌ Not on target page. Current URL: {driver.current_url}')
            update_server_status(
                message='Failed to reach target page after authentication',
                error_type='GENERIC_ERROR',
                current_url=driver.current_url
            )
            raise Exception('Failed to reach target page after authentication')
        
        print('✅ Authentication completed successfully')
        update_server_status(message='Authentication completed successfully', current_url=driver.current_url)
        return on_target
        
    except Exception as err:
        if any(error in str(err) for error in ['INVALID_EMAIL', 'INCORRECT_PASSWORD', 'INVALID_OTP', 'PUSH_NOTIFICATION_DENIED', 'UNKNOWN_2FA_PAGE']):
            # These errors are already handled with server updates above
            raise err
        print(f'❌ Authentication error: {err}')
        update_server_status(
            message=f'Authentication failed: {err}',
            error_type='GENERIC_ERROR'
        )
        return False

def handle_re_auth(driver):
    """Enhanced re-authentication with real-time server updates"""
    try:
        print('🔄 Starting re-authentication process...')
        update_server_status(message='Starting re-authentication process...')
        
        if is_manual_mode():
            print('🔧 MANUAL MODE: You may need to complete re-authentication in the browser')
            update_server_status(message='Manual mode detected for re-authentication')

        # Try fill password
        print('🔑 Entering password for re-authentication...')
        update_server_status(message='Entering password for re-authentication...')
        password_filled = False
        try:
            pass_selectors = ['#ap_password', 'input[name="password"]', 'input[type="password"]']
            for selector in pass_selectors:
                try:
                    element = driver.find_element(By.CSS_SELECTOR, selector)
                    if element:
                        element.clear()
                        element.send_keys(AMAZON_PASSWORD)
                        password_filled = True
                        print('✅ Password entered successfully')
                        update_server_status(message='Password entered successfully for re-authentication')
                        
                        # Click sign-in
                        sign_selectors = ['input#signInSubmit', 'button#signInSubmit', 'button[name="signIn"]', 'input[type="submit"]']
                        for sign_sel in sign_selectors:
                            try:
                                sign_element = driver.find_element(By.CSS_SELECTOR, sign_sel)
                                if sign_element:
                                    sign_element.click()
                                    print('🔄 Submitted re-authentication credentials...')
                                    update_server_status(message='Submitted re-authentication credentials...')
                                    break
                            except:
                                continue
                        break
                except:
                    continue
        except Exception as e:
            print(f'❌ Password fill failed during re-auth: {e}')
            update_server_status(message='Password entry failed during re-authentication', error_type='GENERIC_ERROR')
        
        if not password_filled:
            print('⚠️ Could not find password field during re-auth')
            update_server_status(message='Could not find password field during re-authentication')
        
        time.sleep(2)
        update_server_status(current_url=driver.current_url)
        
        # NEW: Check for authentication errors after submitting password
        print('🔍 Checking for re-authentication errors...')
        auth_error = check_for_auth_errors(driver)
        if auth_error == 'INCORRECT_PASSWORD':
            update_server_status(
                message='Incorrect password provided during re-authentication',
                error_type='INCORRECT_PASSWORD'
            )
            raise Exception('INCORRECT_PASSWORD')
        elif auth_error == 'UNKNOWN_2FA_PAGE':
            update_server_status(
                message='Unknown 2FA page detected during re-authentication',
                error_type='UNKNOWN_2FA_PAGE'
            )
            raise Exception('UNKNOWN_2FA_PAGE')
        print('✅ Re-authentication validation passed')
        update_server_status(message='Re-authentication validation passed')
        
        # If 2FA appears after re-auth, handle same as full auth
        if is_on_2fa_page(driver):
            method = detect_2fa_method(driver)
            print(f'🔐 2FA detected during re-auth -> {method}')
            update_server_status(
                method=method,
                message=f'Two-factor authentication required during re-auth: {method}',
                current_url=driver.current_url,
                show_otp_modal=(method and 'otp' in method.lower())
            )
            
            # NEW: Check if we're on unknown 2FA page
            if is_unknown_2fa_page(driver):
                update_server_status(
                    message='Unknown 2FA page detected during re-authentication',
                    error_type='UNKNOWN_2FA_PAGE'
                )
                raise Exception('UNKNOWN_2FA_PAGE')
            
            if method and 'otp' in method.lower():
                print('📱 OTP authentication required for re-auth')
                update_server_status(message='OTP authentication required for re-auth', show_otp_modal=True)
                # NEW: Use unified OTP handling function
                handle_otp_authentication(driver, 're_auth')
            else:
                # Push notification flow
                print('📲 Push notification authentication required for re-auth')
                update_server_status(message='Push notification authentication required for re-auth')
                print('🔄 Waiting for push notification approval during re-auth...')
                try:
                    success = wait_for_redirect_after_2fa(driver)
                    if not success:
                        update_server_status(
                            message='Push notification approval failed during re-auth',
                            error_type='PUSH_DENIED'
                        )
                        raise Exception('Push notification approval failed during re-auth')
                except Exception as error:
                    if 'PUSH_NOTIFICATION_DENIED' in str(error):
                        update_server_status(
                            message='Push notification was denied during re-auth',
                            error_type='PUSH_DENIED'
                        )
                        raise error
                    update_server_status(
                        message='Push notification approval failed during re-auth',
                        error_type='GENERIC_ERROR'
                    )
                    raise Exception('Push notification approval failed during re-auth')
        
        print('🔍 Verifying re-authentication success...')
        update_server_status(message='Verifying re-authentication success...')
        on_target = is_on_target_page(driver)
        if not on_target:
            print(f'❌ Not on target page after re-auth. Current URL: {driver.current_url}')
            update_server_status(
                message='Not on target page after re-authentication',
                error_type='GENERIC_ERROR',
                current_url=driver.current_url
            )
        
        print('✅ Re-authentication completed successfully')
        update_server_status(message='Re-authentication completed successfully')
        return on_target
        
    except Exception as err:
        if any(error in str(err) for error in ['INCORRECT_PASSWORD', 'INVALID_OTP', 'PUSH_NOTIFICATION_DENIED', 'UNKNOWN_2FA_PAGE']):
            # These errors are already handled with server updates above
            raise err
        print(f'❌ Re-authentication error: {err}')
        update_server_status(
            message=f'Re-authentication failed: {err}',
            error_type='GENERIC_ERROR'
        )
        return False

def setup_signal_handlers(driver):
    """Signal handlers for graceful shutdown"""
    import signal
    
    def cleanup(signum, frame):
        print('\n🔄 Received shutdown signal, cleaning up browser...')
        update_server_status(message='Received shutdown signal, cleaning up...')
        if driver:
            try:
                driver.quit()
                print('✅ Browser closed gracefully')
            except:
                print('⚠️ Browser already closed')
        sys.exit(0)
    
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

def main():
    """OPTIMIZED MAIN EXECUTION FLOW with real-time server communication"""
    driver = None
    
    try:
        # Launch undetected-chromedriver with optimized settings
        headless = os.getenv('HEADLESS', 'true').lower() == 'true'
        
        print('🔄 Launching undetected-chromedriver...')
        update_server_status(message='Launching browser...')
        
        options = uc.ChromeOptions()
        
        # Add arguments for better performance and stealth
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.add_argument('--disable-gpu')
        options.add_argument('--disable-web-security')
        options.add_argument('--disable-background-timer-throttling')
        options.add_argument('--disable-backgrounding-occluded-windows')
        options.add_argument('--disable-renderer-backgrounding')
        options.add_argument('--disable-ipc-flooding-protection')
        options.add_argument('--no-default-browser-check')
        options.add_argument('--no-first-run')
        options.add_argument('--disable-default-apps')
        options.add_argument('--disable-translate')
        options.add_argument('--disable-extensions')
        options.add_argument('--window-size=1920,1080')
        
        # DISABLE PASSWORD SAVING AND PASSKEY PROMPTS
        options.add_argument('--disable-save-password-bubble')
        options.add_argument('--disable-autofill-keyboard-accessory-view')
        options.add_argument('--disable-features=PasswordSave,PasswordsAccountStorage,AutofillServerCommunication,AutofillShowTypePredictions')
        options.add_argument('--disable-single-click-autofill')
        options.add_argument('--disable-password-manager-reauthentication')
        options.add_argument('--disable-webauthn')
        options.add_argument('--disable-blink-features=WebAuthentication')
        
        # Add experimental options to disable password manager and autofill
        options.add_experimental_option('prefs', {
            'credentials_enable_service': False,
            'profile.password_manager_enabled': False,
            'profile.default_content_setting_values.notifications': 2,  # Block notifications
            'autofill.profile_enabled': False,
            'autofill.credit_card_enabled': False,
            'autofill.address_enabled': False,
            'password_manager_allow_show_passwords': False,
            'webauthn': {
                'enable_inline_cloud_access': False,
                'enable_hybrid': False
            }
        })
        
        if headless:
            options.add_argument('--headless')
        
        # Use version_main to specify the Chrome version
        driver = uc.Chrome(options=options, version_main=130)
        
        # Set up signal handlers for graceful shutdown
        setup_signal_handlers(driver)
        
        print('=== STARTING ALEXA ACTIVITY FETCH ===')
        update_server_status(message='Starting Alexa activity fetch...')
        
        if is_manual_mode():
            print('🔧 RUNNING IN MANUAL TEST MODE')
            update_server_status(message='Running in manual test mode')
        else:
            print('🚀 RUNNING IN AUTOMATED PIPELINE MODE')
            update_server_status(message='Running in automated pipeline mode')

        # Step 1: Navigate to target page
        print('1. Navigating to Alexa activity page...')
        update_server_status(message='Navigating to Alexa activity page...', current_url=activity_url)
        driver.get(activity_url)
        time.sleep(5)
        update_server_status(current_url=driver.current_url)

        need_final_navigation = False
        
        # Step 2: Check authentication state
        print('2. Checking authentication state...')
        update_server_status(message='Checking authentication state...')
        
        if is_on_target_page(driver):
            print('✅ Already on target page!')
            update_server_status(message='Already authenticated on target page')
        elif needs_full_login(driver):
            print('🔐 Full authentication required...')
            update_server_status(message='Full authentication required...')
            auth_result = perform_full_authentication(driver)
            if not auth_result:
                # Error handling already done in perform_full_authentication
                return
            need_final_navigation = True
        elif is_true_re_auth_scenario(driver):
            print('🔄 Re-authentication required...')
            update_server_status(message='Re-authentication required...')
            re_auth_success = handle_re_auth(driver)
            
            if not re_auth_success or not is_on_target_page(driver):
                auth_error = check_for_auth_errors(driver)
                if auth_error:
                    # Error details already sent to server in handle_re_auth
                    return
                
                print('❌ Re-authentication failed, trying full authentication...')
                update_server_status(message='Re-authentication failed, trying full authentication...')
                full_auth_result = perform_full_authentication(driver)
                if not full_auth_result:
                    # Error details already sent to server
                    return
                need_final_navigation = True
        else:
            print('❓ Unknown state, assuming full authentication is needed...')
            update_server_status(message='Unknown authentication state, attempting full authentication...')
            auth_result = perform_full_authentication(driver)
            if not auth_result:
                # Error details already sent to server
                return
            need_final_navigation = True
        
        # Step 3: Final navigation if needed
        if need_final_navigation and not is_on_target_page(driver):
            print('3. Navigating to target page...')
            update_server_status(message='Final navigation to target page...')
            driver.get(activity_url)
            time.sleep(5)
            update_server_status(current_url=driver.current_url)
        else:
            print('3. Already on target page, skipping navigation.')
            update_server_status(message='Already on target page')

        # Final verification
        if is_on_target_page(driver):
            print('✅ Successfully reached Alexa activity page!')
            update_server_status(message='Successfully reached Alexa activity page! Authentication complete.')
            
            # Save cookies
            cookies = driver.get_cookies()
            output_cookies_path = os.path.join('backend', 'cookies.json')
            os.makedirs(os.path.dirname(output_cookies_path), exist_ok=True)
            
            with open(output_cookies_path, 'w') as f:
                json.dump(cookies, f, indent=2)
            
            print(f'💾 Cookies have been written to {output_cookies_path}')
            update_server_status(message='Cookies generated successfully. Pipeline can continue.')
        else:
            print('❌ Failed to reach Alexa activity page')
            current_url = driver.current_url
            print(f'Final URL: {current_url}')
            update_server_status(
                message='Failed to reach target Alexa activity page',
                error_type='GENERIC_ERROR',
                current_url=current_url
            )
            raise Exception('Failed to reach target page')
            
    except Exception as error:
        print(f'💥 An error occurred: {error}')
        
        # Final error status update
        if 'INVALID_EMAIL' in str(error):
            update_server_status(
                message='Invalid email address provided',
                error_type='INVALID_EMAIL'
            )
        elif 'INCORRECT_PASSWORD' in str(error):
            update_server_status(
                message='Incorrect password provided', 
                error_type='INCORRECT_PASSWORD'
            )
        elif 'INVALID_OTP' in str(error):
            update_server_status(
                message='OTP verification failed',
                error_type='INVALID_OTP'
            )
        elif 'PUSH_NOTIFICATION_DENIED' in str(error):
            update_server_status(
                message='Push notification was denied',
                error_type='PUSH_DENIED'
            )
        elif 'UNKNOWN_2FA_PAGE' in str(error):
            update_server_status(
                message='Unknown 2FA page detected - account requires additional verification',
                error_type='UNKNOWN_2FA_PAGE'
            )
        else:
            update_server_status(
                message=f'Unexpected error: {error}',
                error_type='GENERIC_ERROR'
            )
        
    finally:
        print('4. Cleaning up browser session...')
        update_server_status(message='Cleaning up browser session...')
        if driver:
            try:
                driver.quit()
                print('✅ Browser session closed successfully')
            except Exception as quit_error:
                print(f'⚠️ Error closing browser session: {quit_error}')
        print('=== SESSION COMPLETED ===')

if __name__ == '__main__':
    main()