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
import { FaEye, FaEyeSlash, FaDownload, FaExclamationTriangle } from 'react-icons/fa';

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
  const [uniqueLogs, setUniqueLogs] = useState([]); // NEW: Store unique logs
  const navigate = useNavigate();

  // Use refs for values that need to be fresh in polling
  const otpSubmittedRef = useRef(false);
  const pushNotificationHandledRef = useRef(false);
  const pollingActiveRef = useRef(false);
  const show2FAModalRef = useRef(false);
  const seenLogMessages = useRef(new Set()); // NEW: Track seen log messages

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

  // NEW: Filter duplicate logs when twoFAInfo changes
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
      
      // Update the ref with all seen messages (including previous ones)
      seenLogMessages.current = new Set([...seenLogMessages.current, ...newSeenMessages]);
      
      // Only update state if we have new unique logs
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
    if (show2FAModal && twoFAInfo?.method?.includes('OTP')) {
      setTimeout(() => {
        if (inputsRef.current[0]) {
          inputsRef.current[0].focus();
        }
      }, 100);
    }
  }, [show2FAModal, twoFAInfo?.method]);

  const handleAcquireData = async () => {
    setError(null);
    setShowProgress(true);
    setHasDownloaded(false);
    setUniqueLogs([]); // Reset logs
    seenLogMessages.current = new Set(); // Reset seen messages

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
      setError(err.message);
      setDownloading(false);
      setShowProgress(false);
      pollingActiveRef.current = false;
    }
  };

  // Handle form submission on Enter key for email/password
  const handleFormSubmit = (e) => {
    e.preventDefault();
    handleAcquireData();
  };

  // polling function - UPDATED: No automatic download
  async function poll2FAStatus(id) {
    try {
      while (pollingActiveRef.current) {
        const res = await fetch(`http://localhost:5000/api/2fa-status/${id}`);
        if (!res.ok) throw new Error('Status fetch failed');
        const info = await res.json();

        // keep UI informed
        setTwoFAInfo(info);

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
        if (info.method && 
            !show2FAModalRef.current && 
            !otpSubmittedRef.current && 
            !pushNotificationHandledRef.current &&
            !info.done && 
            info.status !== 'error') {
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

        if (info.status === 'error') {
          setError(info.error || 'Error in backend pipeline');
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
      setShow2FAModal(false);
      setOtpSubmitted(false);
      setPushNotificationHandled(false);
      otpSubmittedRef.current = false;
      pushNotificationHandledRef.current = false;
      setDownloading(false);
      setShowProgress(false);
      pollingActiveRef.current = false;
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
      const blob = await dl.blob();
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.download = 'matched_audio_transcripts.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(link.href);
      setHasDownloaded(true);
    } catch (e) {
      console.error('Download failed', e);
      setError('Download failed. Please try again.');
    }
  };

  // Handle back to acquisition with warning
  const handleBackToAcquisition = () => {
    if (twoFAInfo?.done && !hasDownloaded) {
      // Show warning modal if data is ready but not downloaded
      setShowWarningModal(true);
    } else {
      // Otherwise, just go back
      setShowProgress(false);
    }
  };

  // Handle confirmed back to acquisition (after warning)
  const handleConfirmBackToAcquisition = () => {
    setShowWarningModal(false);
    setShowProgress(false);
    // Optionally reset states if needed
    setTwoFAInfo(null);
    setRequestId(null);
  };

  // assemble OTP
  const assembledOtp = () => otpDigits.join('').trim();

  // OTP submit handler
  const submitOtp = async () => {
    setError(null);
    const otp = assembledOtp();
    if (otp.length !== 6 || !/^\d{6}$/.test(otp)) {
      setError('Enter the full 6-digit OTP.');
      return;
    }
    if (!requestId) {
      setError('No active request');
      return;
    }

    // Set both state and ref to prevent modal reopening
    setOtpSubmitted(true);
    otpSubmittedRef.current = true;

    // Close the modal immediately and permanently for this session
    setShow2FAModal(false);

    // Clear OTP UI
    setOtpDigits(Array(6).fill(''));
    inputsRef.current.forEach((el) => { if (el) el.value = ''; });

    try {
      const res = await fetch(`http://localhost:5000/api/submit-otp/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp })
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => 'Failed to send OTP');
        setError(txt || 'Failed to send OTP');
        // Only allow reopening if there was an error
        setOtpSubmitted(false);
        otpSubmittedRef.current = false;
      }
      // If successful, otpSubmitted remains true and modal stays closed
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
    // If it's a push notification modal, mark it as handled to prevent reopening
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
    
    // Auto-submit when all 6 digits are filled
    if (idx < 5) {
      const next = inputsRef.current[idx + 1];
      if (next) next.focus();
    } else {
      // If this is the last digit (index 5) and we just filled it, check if all digits are filled
      const allFilled = copy.every(digit => digit !== '');
      if (allFilled) {
        // Small timeout to ensure the last digit is set before submitting
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
      // Handle Enter key in OTP fields
      if (idx === 5) {
        // If Enter is pressed in the last OTP field, submit
        submitOtp();
      } else if (otpDigits[idx]) {
        // If Enter is pressed in any field with content, move to next
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
    
    // Auto-submit if all 6 digits are pasted
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
  
  // NEW: Smaller button styles for progress view
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

  // NEW: Warning modal button styles
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

  // Progress bar and log styles - UPDATED with larger log container
  const progressContainerStyle = {
    width: '90%', // Increased width
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

  // UPDATED: Much larger log container
  const logContainerStyle = {
    maxHeight: '350px', // Increased from 200px to 350px
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
          // Normal form view
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
          // Progress view
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

            {/* UPDATED: Use uniqueLogs instead of twoFAInfo?.logs */}
            <div style={logContainerStyle}>
              {uniqueLogs.map((log, index) => (
                <div key={index} style={logEntryStyle}>
                  <span style={logTimeStyle}>[{formatTime(log.timestamp)}]</span>
                  <span>{log.message}</span>
                </div>
              ))}
            </div>

            {twoFAInfo?.done && (
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

              {twoFAInfo?.method && twoFAInfo.method.includes('OTP') ? (
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
                    >
                      Submit OTP
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
      </motion.div>
    </div>
  );
};

export default SmartAssistant;