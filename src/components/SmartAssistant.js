import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { MatrixBackground, TeamInfo } from './Layout';
import { motion } from 'framer-motion';
import { 
  containerStyle,
  pageContentStyle,
  fancyHeadingStyle,
  spinnerStyle
} from '../constants/styles';
import { FaEye, FaEyeSlash, FaDownload, FaExclamationTriangle, FaTimesCircle, FaPuzzlePiece, FaStop } from 'react-icons/fa';

const SmartAssistant = () => {
  const [teamText, setTeamText] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [requestId, setRequestId] = useState(null);
  const [twoFAInfo, setTwoFAInfo] = useState(null);
  const [show2FAModal, setShow2FAModal] = useState(false);
  const [otpSubmitted, setOtpSubmitted] = useState(false);
  const [pushNotificationHandled, setPushNotificationHandled] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [hasDownloaded, setHasDownloaded] = useState(false);
  const [uniqueLogs, setUniqueLogs] = useState([]);
  const [showAuthErrorModal, setShowAuthErrorModal] = useState(false);
  const [authErrorMessage, setAuthErrorMessage] = useState('');
  const [showPushDeniedModal, setShowPushDeniedModal] = useState(false);
  const [showUnknown2FAModal, setShowUnknown2FAModal] = useState(false);
  const [showGenericErrorModal, setShowGenericErrorModal] = useState(false);
  const [genericErrorMessage, setGenericErrorMessage] = useState('');
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [otpError, setOtpError] = useState(null);
  const navigate = useNavigate();

  // Use refs for values that need to be fresh in polling
  const otpSubmittedRef = useRef(false);
  const pushNotificationHandledRef = useRef(false);
  const pollingActiveRef = useRef(false);
  const show2FAModalRef = useRef(false);
  const seenLogMessages = useRef(new Set());

  // OTP (6 boxes)
  const [otpDigits, setOtpDigits] = useState(Array(6).fill(''));
  const inputsRef = useRef([]);

  const teamInfo = `Team Name: paidRTOS\nTeam Members:\n\t1. Shambo Sarkar\n\t2. Sathvik S\n\t3. Sherwin Allen\n\t4. Meeran Ahmed`;

  useEffect(() => {
    let currentIndex = 0;
    const typingInterval = setInterval(() => {
      setTeamText(teamInfo.slice(0, currentIndex + 1));
      currentIndex++;
      if (currentIndex >= teamInfo.length) clearInterval(typingInterval);
    }, 100);
    return () => clearInterval(typingInterval);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 3000);
    return () => clearTimeout(timer);
  }, []);

  // Handle authentication errors from backend
  useEffect(() => {
    if (twoFAInfo?.errorType) {
      let errorMessage = '';
      
      if (twoFAInfo.errorType === 'INVALID_EMAIL') {
        errorMessage = 'The email address you entered is not associated with an Amazon account. Please check your email and try again.';
        setAuthErrorMessage(errorMessage);
        setShowAuthErrorModal(true);
        setDownloading(false);
        setShowProgress(false);
        pollingActiveRef.current = false;
      } else if (twoFAInfo.errorType === 'INCORRECT_PASSWORD') {
        errorMessage = 'The password you entered is incorrect. Please check your password and try again.';
        setAuthErrorMessage(errorMessage);
        setShowAuthErrorModal(true);
        setDownloading(false);
        setShowProgress(false);
        pollingActiveRef.current = false;
      } else if (twoFAInfo.errorType === 'PUSH_DENIED') {
        setShowPushDeniedModal(true);
        setDownloading(false);
        setShowProgress(false);
        pollingActiveRef.current = false;
      } else if (twoFAInfo.errorType === 'UNKNOWN_2FA_PAGE') {
        setShowUnknown2FAModal(true);
        setDownloading(false);
        setShowProgress(false);
        pollingActiveRef.current = false;
      } else if (twoFAInfo.errorType === 'INVALID_OTP') {
        setOtpError(twoFAInfo.otpError || 'The code you entered is not valid. Please check the code and try again.');
        setShow2FAModal(true);
        setOtpSubmitted(false);
        otpSubmittedRef.current = false;
        setOtpDigits(Array(6).fill(''));
        inputsRef.current.forEach((el) => { if (el) el.value = ''; });
      } else if (twoFAInfo.errorType === 'GENERIC_ERROR') {
        // Handle generic errors with user-friendly modal
        setGenericErrorMessage(twoFAInfo.error || 'An unexpected error occurred. Please try again.');
        setShowGenericErrorModal(true);
        setDownloading(false);
        setShowProgress(false);
        pollingActiveRef.current = false;
      } else if (twoFAInfo.errorType === 'CANCELLED') {
        // Handle cancellation
        console.log('Pipeline was cancelled on server');
        setDownloading(false);
        setShowProgress(false);
        pollingActiveRef.current = false;
        
        // Wait a moment then reset to initial state
        setTimeout(() => {
          completeReset();
        }, 2000);
      }
    }
  }, [twoFAInfo?.errorType, twoFAInfo?.otpError, twoFAInfo?.error]);

  // Handle OTP modal display from backend - FIXED LOGIC
  useEffect(() => {
    if (twoFAInfo?.showOtpModal && !show2FAModalRef.current) {
      console.log('🔄 Opening OTP modal from backend signal');
      setShow2FAModal(true);
      if (twoFAInfo.otpError) {
        setOtpError(twoFAInfo.otpError);
      }
    }
  }, [twoFAInfo?.showOtpModal, twoFAInfo?.otpError]);

  // Filter duplicate logs when twoFAInfo changes
  useEffect(() => {
    if (twoFAInfo?.logs) {
      const newUniqueLogs = [];
      const newSeenMessages = new Set();
      
      twoFAInfo.logs.forEach(log => {
        if (!seenLogMessages.current.has(log.message)) {
          newUniqueLogs.push(log);
          newSeenMessages.add(log.message);
        }
      });
      
      seenLogMessages.current = new Set([...seenLogMessages.current, ...newSeenMessages]);
      
      if (newUniqueLogs.length > 0) {
        setUniqueLogs(prev => [...prev, ...newUniqueLogs]);
      }
    }
  }, [twoFAInfo?.logs]);

  // Reset unique logs when starting new acquisition
  useEffect(() => {
    if (showProgress && downloading) {
      setUniqueLogs([]);
      seenLogMessages.current = new Set();
      setOtpError(null);
    }
  }, [showProgress, downloading]);

  // Update refs when state changes
  useEffect(() => {
    show2FAModalRef.current = show2FAModal;
  }, [show2FAModal]);

  useEffect(() => {
    pushNotificationHandledRef.current = pushNotificationHandled;
  }, [pushNotificationHandled]);

  // Auto-focus first OTP input when modal opens
  useEffect(() => {
    if (show2FAModal && (twoFAInfo?.method?.includes('OTP') || twoFAInfo?.errorType === 'INVALID_OTP')) {
      setTimeout(() => {
        if (inputsRef.current[0]) {
          inputsRef.current[0].focus();
        }
      }, 100);
    }
  }, [show2FAModal, twoFAInfo?.method, twoFAInfo?.errorType]);

  // NEW: Complete reset function
  const completeReset = () => {
    setDownloading(false);
    setShowProgress(false);
    setTwoFAInfo(null);
    setRequestId(null);
    setShow2FAModal(false);
    setOtpSubmitted(false);
    setPushNotificationHandled(false);
    setOtpError(null);
    setOtpDigits(Array(6).fill(''));
    setShowCancelModal(false);
    setCancelling(false);
    pollingActiveRef.current = false;
    otpSubmittedRef.current = false;
    pushNotificationHandledRef.current = false;
    show2FAModalRef.current = false;
    setUniqueLogs([]);
    seenLogMessages.current = new Set();
  };

  // Handle cancellation request
  const handleCancelAcquisition = () => {
    setShowCancelModal(true);
  };

  // Handle confirmed cancellation
  const handleConfirmCancellation = async () => {
    setCancelling(true);
    setShowCancelModal(false);
    
    if (!requestId) {
      console.error('No request ID found for cancellation');
      setCancelling(false);
      return;
    }

    try {
      // Call cancellation endpoint
      const response = await fetch(`http://localhost:5000/api/cancel-acquisition/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error('Failed to cancel acquisition');
      }

      console.log('Data acquisition cancelled successfully');
      
      // Add cancellation log to UI
      if (twoFAInfo) {
        setTwoFAInfo(prev => ({
          ...prev,
          logs: [
            ...(prev.logs || []),
            {
              timestamp: new Date().toISOString(),
              message: 'Data acquisition cancelled by user. Cleaning up...'
            }
          ],
          status: 'cancelled',
          error: 'Data acquisition was cancelled by user.'
        }));
      }

      // Wait a moment for cleanup to complete, then reset
      setTimeout(() => {
        completeReset();
        setCancelling(false);
      }, 1000);

    } catch (error) {
      console.error('Error cancelling acquisition:', error);
      setError('Failed to cancel data acquisition. Please try again.');
      setCancelling(false);
    }
  };

  // Handle cancellation modal close (when user clicks No)
  const handleCancelModalClose = () => {
    setShowCancelModal(false);
  };

  const handleAcquireData = async () => {
    setError(null);
    setShowProgress(true);
    setHasDownloaded(false);
    setUniqueLogs([]);
    setShowAuthErrorModal(false);
    setShowPushDeniedModal(false);
    setShowUnknown2FAModal(false);
    setShowGenericErrorModal(false);
    setAuthErrorMessage('');
    setGenericErrorMessage('');
    setOtpError(null);
    seenLogMessages.current = new Set();

    if (!email.trim() || !password.trim()) {
      setError("Please fill in both Email and Password fields.");
      setShowProgress(false);
      return;
    }

    setDownloading(true);
    setOtpSubmitted(false);
    setPushNotificationHandled(false);
    otpSubmittedRef.current = false;
    pushNotificationHandledRef.current = false;
    pollingActiveRef.current = true;
    
    try {
      const response = await fetch('http://localhost:5000/api/packet-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, source: 'SmartAssistant' })
      });
      if (!response.ok) {
        throw new Error(`Failed to start pipeline: ${response.statusText}`);
      }
      const json = await response.json();
      if (!json.requestId) {
        throw new Error('No requestId returned from server');
      }
      setRequestId(json.requestId);

      // Start polling
      poll2FAStatus(json.requestId);
    } catch (err) {
      console.error("Error acquiring data:", err);
      // Show generic error modal for any unexpected errors
      setGenericErrorMessage('Failed to start data acquisition. Please check your connection and try again.');
      setShowGenericErrorModal(true);
      setDownloading(false);
      setShowProgress(false);
    }
  };

  // Handle form submission on Enter key for email/password
  const handleFormSubmit = (e) => {
    e.preventDefault();
    handleAcquireData();
  };

  // polling function
  async function poll2FAStatus(id) {
    try {
      while (pollingActiveRef.current) {
        const res = await fetch(`http://localhost:5000/api/2fa-status/${id}`);
        if (!res.ok) throw new Error('Status fetch failed');
        const info = await res.json();

        // keep UI informed
        setTwoFAInfo(info);

        // Check if pipeline was cancelled
        if (info.status === 'cancelled') {
          console.log('Pipeline was cancelled on server');
          setTwoFAInfo(info);
          setDownloading(false);
          setShowProgress(false);
          pollingActiveRef.current = false;
          
          // Wait a moment then reset to initial state
          setTimeout(() => {
            completeReset();
          }, 2000);
          break;
        }

        // Improved push notification detection and handling
        const isPushNotificationCompleted = info.method && 
          info.method.includes('Push') && 
          info.currentUrl && 
          info.currentUrl.includes('/alexa-privacy/apd/');

        // If push notification is completed, mark it as handled
        if (isPushNotificationCompleted && !pushNotificationHandledRef.current) {
          console.log('🔄 Push notification completed - marking as handled');
          setPushNotificationHandled(true);
          pushNotificationHandledRef.current = true;
          // Close modal if it's open
          if (show2FAModalRef.current) {
            setShow2FAModal(false);
          }
        }

        // CRITICAL FIX: Only open modal if:
        // 1. Backend reports a method 
        // 2. Modal isn't already open
        // 3. OTP hasn't been submitted (using ref for fresh value)
        // 4. Push notification hasn't been handled (NEW condition)
        // 5. We're not in a completed state
        // 6. No authentication error
        // 7. Not an OTP error (handled separately)
        if (info.method && 
            !show2FAModalRef.current && 
            !otpSubmittedRef.current && 
            !pushNotificationHandledRef.current &&
            !info.done && 
            info.status !== 'error' &&
            !info.errorType &&
            !info.showOtpModal) {
          setShow2FAModal(true);
        }

        // pipeline finished -> update state but don't auto-download
        if (info.done) {
          setShow2FAModal(false);
          setOtpSubmitted(false);
          setPushNotificationHandled(false);
          otpSubmittedRef.current = false;
          pushNotificationHandledRef.current = false;
          setDownloading(false);
          pollingActiveRef.current = false;
          break;
        }

        if (info.status === 'error' && !info.errorType) {
          // This is a generic error without specific type
          setGenericErrorMessage(info.error || 'An unexpected error occurred. Please try again.');
          setShowGenericErrorModal(true);
          setShow2FAModal(false);
          setOtpSubmitted(false);
          setPushNotificationHandled(false);
          otpSubmittedRef.current = false;
          pushNotificationHandledRef.current = false;
          setDownloading(false);
          setShowProgress(false);
          pollingActiveRef.current = false;
          break;
        }

        // wait before next poll
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error('Polling error', err);
      setError(err.message);
      completeReset();
    }
  }

  // Add a new function to handle manual download
  const handleDownload = async () => {
    if (!requestId) {
      setError('No request ID found for download');
      return;
    }

    try {
      const dl = await fetch(`http://localhost:5000/api/download/${requestId}`);
      if (!dl.ok) {
        throw new Error('Download failed');
      }
      
      // Check if we have the new HTML report or fall back to JSON
      const contentType = dl.headers.get('content-type');
      
      if (contentType && contentType.includes('text/html')) {
        // HTML report download
        const blob = await dl.blob();
        const link = document.createElement('a');
        link.href = window.URL.createObjectURL(blob);
        link.download = 'alexa_voice_activity_report.html';
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(link.href);
      } else {
        // Fallback to JSON download
        const blob = await dl.blob();
        const link = document.createElement('a');
        link.href = window.URL.createObjectURL(blob);
        link.download = 'matched_audio_transcripts.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(link.href);
      }
      
      setHasDownloaded(true);
    } catch (e) {
      console.error('Download failed', e);
      setError('Download failed. Please try again.');
    }
  };

  // Handle back to acquisition with warning
  const handleBackToAcquisition = () => {
    if (twoFAInfo?.done && !hasDownloaded) {
      setShowWarningModal(true);
    } else {
      completeReset();
    }
  };

  // Handle confirmed back to acquisition (after warning)
  const handleConfirmBackToAcquisition = () => {
    setShowWarningModal(false);
    completeReset();
  };

  // Handle authentication error modal close
  const handleAuthErrorModalClose = () => {
    setShowAuthErrorModal(false);
    setAuthErrorMessage('');
    completeReset();
  };

  // Handle push denied modal close - FIXED
  const handlePushDeniedModalClose = () => {
    setShowPushDeniedModal(false);
    completeReset(); // Use complete reset instead of partial reset
  };

  // Handle unknown 2FA modal close
  const handleUnknown2FAModalClose = () => {
    setShowUnknown2FAModal(false);
    completeReset();
  };

  // Handle generic error modal close
  const handleGenericErrorModalClose = () => {
    setShowGenericErrorModal(false);
    setGenericErrorMessage('');
    completeReset();
  };

  // assemble OTP
  const assembledOtp = () => otpDigits.join('').trim();

  // OTP submit handler
  const submitOtp = async () => {
    setError(null);
    setOtpError(null);
    const otp = assembledOtp();
    if (otp.length !== 6 || !/^\d{6}$/.test(otp)) {
      setError('Enter the full 6-digit OTP.');
      return;
    }
    if (!requestId) {
      setError('No active request');
      return;
    }

    setOtpSubmitted(true);
    otpSubmittedRef.current = true;
    setShow2FAModal(false); // NEW: Immediately close modal on submit

    try {
      const res = await fetch(`http://localhost:5000/api/submit-otp/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp })
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => 'Failed to send OTP');
        setError(txt || 'Failed to send OTP');
        setOtpSubmitted(false);
        otpSubmittedRef.current = false;
      }
    } catch (err) {
      console.error('Failed to send OTP', err);
      setError('Failed to send OTP to server');
      setOtpSubmitted(false);
      otpSubmittedRef.current = false;
    }
  };

  // Handle manual modal close for push notification
  const handleManualModalClose = () => {
    setShow2FAModal(false);
    setOtpError(null);
    if (twoFAInfo?.method?.includes('Push')) {
      setPushNotificationHandled(true);
      pushNotificationHandledRef.current = true;
    }
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      pollingActiveRef.current = false;
    };
  }, []);

  // OTP handlers
  const handleOtpChange = (e, idx) => {
    const val = e.target.value;
    if (!val) {
      const copy = [...otpDigits];
      copy[idx] = '';
      setOtpDigits(copy);
      return;
    }
    const digit = val.replace(/\D/g, '')[0];
    if (!digit) return;
    const copy = [...otpDigits];
    copy[idx] = digit;
    setOtpDigits(copy);
    
    if (idx < 5) {
      const next = inputsRef.current[idx + 1];
      if (next) next.focus();
    } else {
      const allFilled = copy.every(digit => digit !== '');
      if (allFilled) {
        setTimeout(() => {
          submitOtp();
        }, 100);
      }
    }
  };

  const handleOtpKeyDown = (e, idx) => {
    if (e.key === 'Backspace') {
      if (otpDigits[idx]) {
        const copy = [...otpDigits];
        copy[idx] = '';
        setOtpDigits(copy);
      } else if (idx > 0) {
        const prev = inputsRef.current[idx - 1];
        if (prev) {
          prev.focus();
          const copy = [...otpDigits];
          copy[idx - 1] = '';
          setOtpDigits(copy);
        }
      }
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      inputsRef.current[idx - 1]?.focus();
    } else if (e.key === 'ArrowRight' && idx < 5) {
      inputsRef.current[idx + 1]?.focus();
    } else if (e.key === 'Enter') {
      if (idx === 5) {
        submitOtp();
      } else if (otpDigits[idx]) {
        const next = inputsRef.current[idx + 1];
        if (next) next.focus();
      }
    }
  };

  const handleOtpPaste = (e, startIdx = 0) => {
    e.preventDefault();
    const paste = (e.clipboardData || window.clipboardData).getData('text');
    const digits = paste.replace(/\D/g, '').slice(0, 6);
    if (!digits) return;
    const copy = [...otpDigits];
    for (let i = 0; i < digits.length && startIdx + i < 6; i++) {
      copy[startIdx + i] = digits[i];
      if (inputsRef.current[startIdx + i]) {
        inputsRef.current[startIdx + i].value = digits[i];
      }
    }
    setOtpDigits(copy);
    const nextFocusIdx = Math.min(5, startIdx + digits.length);
    setTimeout(() => inputsRef.current[nextFocusIdx]?.focus(), 0);
    
    if (digits.length === 6) {
      setTimeout(() => {
        submitOtp();
      }, 100);
    }
  };

  // Format timestamp for logs
  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  // styles
  const bigButtonStyle = {
    width: '80%',
    padding: '20px',
    backgroundColor: '#0f0',
    border: 'none',
    color: '#000',
    cursor: 'pointer',
    fontSize: '1.5rem',
    borderRadius: '10px',
    margin: '20px auto',
    display: 'block',
    fontFamily: "'Orbitron', sans-serif",
    textTransform: 'uppercase',
    boxShadow: '0 0 20px rgba(0,255,0,0.7)',
    transition: 'transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out'
  };
  const bigButtonHover = { scale: 1.1, boxShadow: '0 0 30px rgba(0,255,0,1)' };
  
  const smallButtonStyle = {
    padding: '12px 24px',
    backgroundColor: '#0f0',
    border: 'none',
    color: '#000',
    cursor: 'pointer',
    fontSize: '1rem',
    borderRadius: '6px',
    margin: '0 10px',
    fontFamily: "'Orbitron', sans-serif",
    textTransform: 'uppercase',
    boxShadow: '0 0 10px rgba(0,255,0,0.7)',
    transition: 'transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out',
    minWidth: '180px'
  };
  const smallButtonHover = { scale: 1.05, boxShadow: '0 0 15px rgba(0,255,0,0.9)' };

  const cancelButtonStyle = {
    padding: '12px 24px',
    backgroundColor: 'transparent',
    border: '2px solid #ff4444',
    color: '#ff4444',
    cursor: 'pointer',
    fontSize: '1rem',
    borderRadius: '6px',
    margin: '0 10px',
    fontFamily: "'Orbitron', sans-serif",
    textTransform: 'uppercase',
    boxShadow: '0 0 10px rgba(255,68,68,0.7)',
    transition: 'transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out',
    minWidth: '180px'
  };

  const inputWrapperStyle = { width: '80%', margin: '20px auto 0 auto', display: 'block', height: '56px' };
  const passwordWrapperStyle = { width: '80%', margin: '20px auto 0 auto', position: 'relative', display: 'block', height: '56px' };
  const inputStyle = {
    width: '100%', boxSizing: 'border-box', padding: '15px 50px 15px 20px',
    backgroundColor: 'rgba(0,0,0,0.8)', border: '2px solid #0f0', borderRadius: '10px',
    color: '#0f0', fontSize: '1.2rem', fontFamily: "'Orbitron', sans-serif",
    textAlign: 'center', boxShadow: '0 0 10px rgba(0,255,0,0.5)', outline: 'none',
  };
  const eyeIconStyle = { 
    position: 'absolute', 
    right: '20px', 
    top: '50%', 
    transform: 'translateY(-50%)', 
    color: '#0f0', 
    cursor: 'pointer', 
    fontSize: '1.5rem', 
    zIndex: 2, 
    background: 'transparent', 
    border: 'none', 
    padding: 0 
  };
  const otpContainerStyle = { display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 };
  const otpBoxStyle = { 
    width: 44, 
    height: 54, 
    textAlign: 'center', 
    fontSize: 24, 
    borderRadius: 6, 
    border: '2px solid #0f0', 
    background: '#000', 
    color: '#0f0', 
    outline: 'none', 
    fontFamily: "'Orbitron', sans-serif", 
    boxShadow: '0 0 8px rgba(0,255,0,0.3)' 
  };
  const modalButtonStyle = { 
    padding: '10px 16px', 
    background: '#0f0', 
    color: '#000', 
    borderRadius: 6,
    cursor: 'pointer',
    border: 'none',
    fontFamily: "'Orbitron', sans-serif",
    fontSize: '1rem',
    margin: '0 4px'
  };
  const closeButtonStyle = {
    padding: '10px 16px', 
    background: 'transparent', 
    color: '#0f0', 
    border: '1px solid #0f0', 
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: "'Orbitron', sans-serif",
    fontSize: '1rem',
    margin: '0 4px'
  };

  const warningButtonStyle = {
    padding: '10px 20px',
    borderRadius: '6px',
    border: 'none',
    cursor: 'pointer',
    fontFamily: "'Orbitron', sans-serif",
    fontSize: '1rem',
    margin: '0 10px',
    transition: 'all 0.2s ease-in-out'
  };

  const authErrorButtonStyle = {
    padding: '12px 24px',
    borderRadius: '6px',
    border: 'none',
    cursor: 'pointer',
    fontFamily: "'Orbitron', sans-serif",
    fontSize: '1rem',
    margin: '0 10px',
    transition: 'all 0.2s ease-in-out',
    minWidth: '120px'
  };

  const pushDeniedButtonStyle = {
    padding: '12px 24px',
    borderRadius: '6px',
    border: 'none',
    cursor: 'pointer',
    fontFamily: "'Orbitron', sans-serif",
    fontSize: '1rem',
    margin: '0 10px',
    transition: 'all 0.2s ease-in-out',
    minWidth: '120px'
  };

  const unknown2FAButtonStyle = {
    padding: '12px 24px',
    borderRadius: '6px',
    border: 'none',
    cursor: 'pointer',
    fontFamily: "'Orbitron', sans-serif",
    fontSize: '1rem',
    margin: '0 10px',
    transition: 'all 0.2s ease-in-out',
    minWidth: '120px'
  };

  const genericErrorButtonStyle = {
    padding: '12px 24px',
    borderRadius: '6px',
    border: 'none',
    cursor: 'pointer',
    fontFamily: "'Orbitron', sans-serif",
    fontSize: '1rem',
    margin: '0 10px',
    transition: 'all 0.2s ease-in-out',
    minWidth: '120px'
  };

  const progressContainerStyle = {
    width: '90%',
    margin: '20px auto',
    padding: '25px',
    backgroundColor: 'rgba(0,0,0,0.8)',
    border: '2px solid #0f0',
    borderRadius: '10px',
    color: '#0f0',
    fontFamily: "'Orbitron', sans-serif"
  };

  const progressBarStyle = {
    width: '100%',
    height: '20px',
    backgroundColor: 'rgba(0,255,0,0.2)',
    borderRadius: '10px',
    margin: '15px 0',
    overflow: 'hidden'
  };

  const progressFillStyle = {
    height: '100%',
    backgroundColor: '#0f0',
    borderRadius: '10px',
    transition: 'width 0.5s ease-in-out',
    width: `${twoFAInfo?.progress || 0}%`
  };

  const logContainerStyle = {
    maxHeight: '350px',
    minHeight: '200px',
    overflowY: 'auto',
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: '15px',
    borderRadius: '8px',
    marginTop: '15px',
    fontSize: '0.95rem',
    border: '1px solid rgba(0,255,0,0.3)'
  };

  const logEntryStyle = {
    margin: '8px 0',
    padding: '8px',
    borderBottom: '1px solid rgba(0,255,0,0.2)',
    lineHeight: '1.4'
  };

  const logTimeStyle = {
    color: '#8f8',
    fontSize: '0.85rem',
    marginRight: '12px',
    fontWeight: 'bold'
  };

  if (loading) {
    return (
      <div style={containerStyle}>
        <MatrixBackground />
        <TeamInfo teamText={teamText} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
          <p style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: 24 }}>INITIALIZING SMART ASSISTANT...</p>
          <div style={spinnerStyle} />
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <MatrixBackground />
      <TeamInfo teamText={teamText} />
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={pageContentStyle}>
        <h1 style={{ ...fancyHeadingStyle, fontSize: '2.5rem', marginBottom: '48px' }}>SMART ASSISTANT DATA</h1>

        {error && <p style={{ color: 'red', fontSize: '1.2rem' }}>{error}</p>}

        {!showProgress ? (
          <form onSubmit={handleFormSubmit}>
            <div style={inputWrapperStyle}>
              <input 
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div style={passwordWrapperStyle}>
              <input 
                type={showPassword ? "text" : "password"}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
              />
              <button
                type="button"
                style={eyeIconStyle}
                onClick={() => setShowPassword((prev) => !prev)}
                tabIndex={0}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <FaEyeSlash /> : <FaEye />}
              </button>
            </div>

            <motion.button 
              type="submit"
              style={bigButtonStyle}
              whileHover={bigButtonHover}
              disabled={downloading}
            >
              {downloading ? 'Acquiring Data...' : 'Acquire Data'}
            </motion.button>
          </form>
        ) : (
          <div style={progressContainerStyle}>
            <h3 style={{ textAlign: 'center', marginBottom: '20px', fontSize: '1.5rem' }}>
              {twoFAInfo?.done ? 'DATA EXTRACTION COMPLETE!' : 'ACQUIRING DATA...'}
            </h3>
            
            <div style={progressBarStyle}>
              <div style={progressFillStyle} />
            </div>
            
            <div style={{ textAlign: 'center', marginBottom: '15px', fontSize: '1.1rem' }}>
              {twoFAInfo?.progress || 0}% Complete
            </div>

            <div style={logContainerStyle}>
              {uniqueLogs.map((log, index) => (
                <div key={index} style={logEntryStyle}>
                  <span style={logTimeStyle}>[{formatTime(log.timestamp)}]</span>
                  <span>{log.message}</span>
                </div>
              ))}
            </div>

            {twoFAInfo?.done ? (
              <div style={{ textAlign: 'center', marginTop: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', alignItems: 'center', flexWrap: 'nowrap' }}>
                  <motion.button 
                    onClick={handleDownload}
                    style={smallButtonStyle}
                    whileHover={smallButtonHover}
                  >
                    <FaDownload style={{ marginRight: '8px' }} />
                    Download Data
                  </motion.button>
                  <motion.button 
                    onClick={handleBackToAcquisition}
                    style={{ 
                      ...smallButtonStyle, 
                      backgroundColor: 'transparent', 
                      color: '#0f0', 
                      border: '2px solid #0f0' 
                    }}
                    whileHover={{ 
                      scale: 1.05, 
                      boxShadow: '0 0 15px rgba(0,255,0,0.9)',
                      backgroundColor: 'rgba(0,255,0,0.1)'
                    }}
                  >
                    Back to Acquisition
                  </motion.button>
                </div>
              </div>
            ) : (
              // NEW: Cancel button shown when pipeline is running and not done
              <div style={{ textAlign: 'center', marginTop: '20px' }}>
                <motion.button 
                  onClick={handleCancelAcquisition}
                  style={{ 
                    ...cancelButtonStyle, 
                    opacity: cancelling ? 0.6 : 1
                  }}
                  whileHover={cancelling ? {} : { 
                    scale: 1.05, 
                    boxShadow: '0 0 15px rgba(255,68,68,0.9)',
                    backgroundColor: 'rgba(255,68,68,0.1)'
                  }}
                  disabled={cancelling}
                >
                  <FaStop style={{ marginRight: '8px' }} />
                  {cancelling ? 'Cancelling...' : 'Cancel Data Acquisition'}
                </motion.button>
              </div>
            )}
          </div>
        )}

        {!showProgress && (
          <motion.button 
            onClick={() => navigate('/iotextractor')}
            style={bigButtonStyle}
            whileHover={bigButtonHover}
          >
            Back to Devices
          </motion.button>
        )}

        {/* 2FA Modal */}
        {show2FAModal && (
          <div style={{
            position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
          }}>
            <div style={{ width: 420, padding: 24, background: '#000', border: '2px solid #0f0', borderRadius: 8, color: '#0f0', textAlign: 'center' }}>
              <h2>Two-Factor Authentication Required</h2>
              <p style={{ color: '#afa' }}>{twoFAInfo?.method || 'Waiting for detection...'}</p>
              <p style={{ fontSize: 14 }}>{twoFAInfo?.message || 'Please follow instructions on your device.'}</p>

              {otpError && (
                <p style={{ color: '#f00', fontSize: 14, marginBottom: 10, fontWeight: 'bold' }}>
                  {otpError}
                </p>
              )}

              {/* FIX: Show OTP form for both OTP method AND invalid OTP error */}
              {(twoFAInfo?.method && twoFAInfo.method.includes('OTP')) || twoFAInfo?.errorType === 'INVALID_OTP' ? (
                <>
                  <div style={otpContainerStyle} onPaste={(e) => handleOtpPaste(e, 0)}>
                    {Array.from({ length: 6 }).map((_, idx) => (
                      <input
                        key={idx}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={1}
                        ref={(el) => (inputsRef.current[idx] = el)}
                        style={otpBoxStyle}
                        onChange={(e) => handleOtpChange(e, idx)}
                        onKeyDown={(e) => handleOtpKeyDown(e, idx)}
                        onPaste={(e) => handleOtpPaste(e, idx)}
                        value={otpDigits[idx]}
                        aria-label={`OTP digit ${idx + 1}`}
                      />
                    ))}
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <button 
                      onClick={submitOtp} 
                      style={modalButtonStyle}
                      disabled={otpSubmitted}
                    >
                      {otpSubmitted ? 'Submitting...' : 'Submit OTP'}
                    </button>
                    <button 
                      onClick={handleManualModalClose} 
                      style={closeButtonStyle}
                    >
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>Waiting for push notification approval on your device...</p>
                  <div style={{ marginTop: 12 }}>
                    <button 
                      onClick={handleManualModalClose} 
                      style={closeButtonStyle}
                    >
                      Close
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Warning Modal */}
        {showWarningModal && (
          <div style={{
            position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000
          }}>
            <div style={{ 
              width: 450, 
              padding: '24px', 
              background: '#000', 
              border: '2px solid #ff0', 
              borderRadius: '8px', 
              color: '#ff0', 
              textAlign: 'center',
              boxShadow: '0 0 20px rgba(255,255,0,0.5)'
            }}>
              <div style={{ fontSize: '2rem', marginBottom: '15px' }}>
                <FaExclamationTriangle />
              </div>
              <h2 style={{ color: '#ff0', marginBottom: '15px' }}>Warning: Data Not Downloaded</h2>
              <p style={{ marginBottom: '10px', fontSize: '1.1rem' }}>
                You haven't downloaded your extracted data yet.
              </p>
              <p style={{ marginBottom: '20px', fontSize: '1rem', color: '#ff8' }}>
                If you go back now, you will need to run the entire extraction process again to get your data.
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '15px' }}>
                <button 
                  onClick={() => setShowWarningModal(false)}
                  style={{
                    ...warningButtonStyle,
                    backgroundColor: '#0f0',
                    color: '#000'
                  }}
                  onMouseOver={(e) => {
                    e.target.style.backgroundColor = '#0c0';
                    e.target.style.transform = 'scale(1.05)';
                  }}
                  onMouseOut={(e) => {
                    e.target.style.backgroundColor = '#0f0';
                    e.target.style.transform = 'scale(1)';
                  }}
                >
                  Continue Extraction
                </button>
                <button 
                  onClick={handleConfirmBackToAcquisition}
                  style={{
                    ...warningButtonStyle,
                    backgroundColor: 'transparent',
                    color: '#ff0',
                    border: '1px solid #ff0'
                  }}
                  onMouseOver={(e) => {
                    e.target.style.backgroundColor = 'rgba(255,255,0,0.1)';
                    e.target.style.transform = 'scale(1.05)';
                  }}
                  onMouseOut={(e) => {
                    e.target.style.backgroundColor = 'transparent';
                    e.target.style.transform = 'scale(1)';
                  }}
                >
                  Go Back Anyway
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Authentication Error Modal */}
        {showAuthErrorModal && (
          <div style={{
            position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10001
          }}>
            <div style={{ 
              width: 500, 
              padding: '24px', 
              background: '#000', 
              border: '2px solid #f00', 
              borderRadius: '8px', 
              color: '#f00', 
              textAlign: 'center',
              boxShadow: '0 0 20px rgba(255,0,0,0.5)'
            }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '15px' }}>
                <FaTimesCircle />
              </div>
              <h2 style={{ color: '#f00', marginBottom: '15px', fontSize: '1.5rem' }}>Authentication Error</h2>
              <p style={{ marginBottom: '20px', fontSize: '1.1rem', lineHeight: '1.5', color: '#f88' }}>
                {authErrorMessage}
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '15px' }}>
                <button 
                  onClick={handleAuthErrorModalClose}
                  style={{
                    ...authErrorButtonStyle,
                    backgroundColor: '#f00',
                    color: '#fff'
                  }}
                  onMouseOver={(e) => {
                    e.target.style.backgroundColor = '#c00';
                    e.target.style.transform = 'scale(1.05)';
                  }}
                  onMouseOut={(e) => {
                    e.target.style.backgroundColor = '#f00';
                    e.target.style.transform = 'scale(1)';
                  }}
                >
                  Try Again
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Push Denied Modal */}
        {showPushDeniedModal && (
          <div style={{
            position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10002
          }}>
            <div style={{ 
              width: 500, 
              padding: '24px', 
              background: '#000', 
              border: '2px solid #f00', 
              borderRadius: '8px', 
              color: '#f00', 
              textAlign: 'center',
              boxShadow: '0 0 20px rgba(255,0,0,0.5)'
            }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '15px' }}>
                <FaTimesCircle />
              </div>
              <h2 style={{ color: '#f00', marginBottom: '15px', fontSize: '1.5rem' }}>Push Notification Denied</h2>
              <p style={{ marginBottom: '20px', fontSize: '1.1rem', lineHeight: '1.5', color: '#f88' }}>
                The sign in attempt was denied from your companion device or mobile app.
              </p>
              <p style={{ marginBottom: '20px', fontSize: '1rem', color: '#faa' }}>
                Please try again and make sure to approve the push notification on your device.
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '15px' }}>
                <button 
                  onClick={handlePushDeniedModalClose}
                  style={{
                    ...pushDeniedButtonStyle,
                    backgroundColor: '#f00',
                    color: '#fff'
                  }}
                  onMouseOver={(e) => {
                    e.target.style.backgroundColor = '#c00';
                    e.target.style.transform = 'scale(1.05)';
                  }}
                  onMouseOut={(e) => {
                    e.target.style.backgroundColor = '#f00';
                    e.target.style.transform = 'scale(1)';
                  }}
                >
                  Try Again
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Unknown 2FA Modal */}
        {showUnknown2FAModal && (
          <div style={{
            position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10003
          }}>
            <div style={{ 
              width: 550, 
              padding: '24px', 
              background: '#000', 
              border: '2px solid #ff8c00', 
              borderRadius: '8px', 
              color: '#ff8c00', 
              textAlign: 'center',
              boxShadow: '0 0 20px rgba(255,140,0,0.5)'
            }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '15px' }}>
                <FaPuzzlePiece />
              </div>
              <h2 style={{ color: '#ff8c00', marginBottom: '15px', fontSize: '1.5rem' }}>Additional Verification Required</h2>
              <p style={{ marginBottom: '15px', fontSize: '1.1rem', lineHeight: '1.5', color: '#ffa' }}>
                Data was acquired too many times with this account.
              </p>
              <p style={{ marginBottom: '20px', fontSize: '1rem', color: '#ffb' }}>
                Amazon is asking for additional verification that cannot be automated.
              </p>
              <p style={{ marginBottom: '20px', fontSize: '1rem', color: '#ff8' }}>
                Please try again tomorrow.
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '15px' }}>
                <button 
                  onClick={handleUnknown2FAModalClose}
                  style={{
                    ...unknown2FAButtonStyle,
                    backgroundColor: '#ff8c00',
                    color: '#000'
                  }}
                  onMouseOver={(e) => {
                    e.target.style.backgroundColor = '#ff7b00';
                    e.target.style.transform = 'scale(1.05)';
                  }}
                  onMouseOut={(e) => {
                    e.target.style.backgroundColor = '#ff8c00';
                    e.target.style.transform = 'scale(1)';
                  }}
                >
                  Try Again Tomorrow
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Generic Error Modal */}
        {showGenericErrorModal && (
          <div style={{
            position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10004
          }}>
            <div style={{ 
              width: 500, 
              padding: '24px', 
              background: '#000', 
              border: '2px solid #f00', 
              borderRadius: '8px', 
              color: '#f00', 
              textAlign: 'center',
              boxShadow: '0 0 20px rgba(255,0,0,0.5)'
            }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '15px' }}>
                <FaTimesCircle />
              </div>
              <h2 style={{ color: '#f00', marginBottom: '15px', fontSize: '1.5rem' }}>Unexpected Error</h2>
              <p style={{ marginBottom: '20px', fontSize: '1.1rem', lineHeight: '1.5', color: '#f88' }}>
                {genericErrorMessage}
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '15px' }}>
                <button 
                  onClick={handleGenericErrorModalClose}
                  style={{
                    ...genericErrorButtonStyle,
                    backgroundColor: '#f00',
                    color: '#fff'
                  }}
                  onMouseOver={(e) => {
                    e.target.style.backgroundColor = '#c00';
                    e.target.style.transform = 'scale(1.05)';
                  }}
                  onMouseOut={(e) => {
                    e.target.style.backgroundColor = '#f00';
                    e.target.style.transform = 'scale(1)';
                  }}
                >
                  Try Again
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Cancellation Confirmation Modal */}
        {showCancelModal && (
          <div style={{
            position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10005
          }}>
            <div style={{ 
              width: 450, 
              padding: '24px', 
              background: '#000', 
              border: '2px solid #ff4444', 
              borderRadius: '8px', 
              color: '#ff4444', 
              textAlign: 'center',
              boxShadow: '0 0 20px rgba(255,68,68,0.5)'
            }}>
              <div style={{ fontSize: '2rem', marginBottom: '15px' }}>
                <FaExclamationTriangle />
              </div>
              <h2 style={{ color: '#ff4444', marginBottom: '15px' }}>Cancel Data Acquisition?</h2>
              <p style={{ marginBottom: '10px', fontSize: '1.1rem' }}>
                Are you sure you want to cancel the data acquisition?
              </p>
              <p style={{ marginBottom: '20px', fontSize: '1rem', color: '#ff8888' }}>
                This will stop the current process and you will need to start over.
              </p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '15px' }}>
                <button 
                  onClick={handleConfirmCancellation}
                  style={{
                    padding: '12px 24px',
                    borderRadius: '6px',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: "'Orbitron', sans-serif",
                    fontSize: '1rem',
                    margin: '0 10px',
                    transition: 'all 0.2s ease-in-out',
                    minWidth: '120px',
                    backgroundColor: '#ff4444',
                    color: '#fff'
                  }}
                  onMouseOver={(e) => {
                    e.target.style.backgroundColor = '#cc3333';
                    e.target.style.transform = 'scale(1.05)';
                  }}
                  onMouseOut={(e) => {
                    e.target.style.backgroundColor = '#ff4444';
                    e.target.style.transform = 'scale(1)';
                  }}
                >
                  Yes, Cancel
                </button>
                <button 
                  onClick={handleCancelModalClose}
                  style={{
                    padding: '12px 24px',
                    borderRadius: '6px',
                    border: '1px solid #0f0',
                    cursor: 'pointer',
                    fontFamily: "'Orbitron', sans-serif",
                    fontSize: '1rem',
                    margin: '0 10px',
                    transition: 'all 0.2s ease-in-out',
                    minWidth: '120px',
                    backgroundColor: 'transparent',
                    color: '#0f0'
                  }}
                  onMouseOver={(e) => {
                    e.target.style.backgroundColor = 'rgba(0,255,0,0.1)';
                    e.target.style.transform = 'scale(1.05)';
                  }}
                  onMouseOut={(e) => {
                    e.target.style.backgroundColor = 'transparent';
                    e.target.style.transform = 'scale(1)';
                  }}
                  autoFocus
                >
                  No, Continue
                </button>
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
};

export default SmartAssistant;