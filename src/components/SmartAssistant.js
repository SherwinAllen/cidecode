import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MatrixBackground, TeamInfo } from './Layout';
import { motion } from 'framer-motion';
import { 
  containerStyle,
  pageContentStyle,
  fancyHeadingStyle,
  spinnerStyle
} from '../constants/styles';
import { FaEye, FaEyeSlash } from 'react-icons/fa'; // Add this import at the top

const SmartAssistant = () => {
  const [teamText, setTeamText] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);  // Loading state added
  const [showPassword, setShowPassword] = useState(false); // Add this state
  const navigate = useNavigate();

  const teamInfo = `Team Name: paidRTOS\nTeam Members:\n\t1. Shambo Sarkar\n\t2. Sathvik S\n\t3. Sherwin Allen\n\t4. Meeran Ahmed`;

  // Typing animation for team info
  useEffect(() => {
    let currentIndex = 0;
    const typingInterval = setInterval(() => {
      setTeamText(teamInfo.slice(0, currentIndex + 1));
      currentIndex++;
      if (currentIndex >= teamInfo.length) clearInterval(typingInterval);
    }, 100);
    return () => clearInterval(typingInterval);
  }, []);

  // Simulate loading/initialization (similar to SmartWatch)
  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 3000);
    return () => clearTimeout(timer);
  }, []);

  // Function to acquire data and trigger a file download.
  // Pass email, password and source=SmartAssistant as query parameters.
  const handleAcquireData = async () => {
    setError(null);

    // Validation for empty fields
    if (!email.trim() || !password.trim()) {
      setError("Please fill in both Email and Password fields.");
      return;
    }

    setDownloading(true);
    try {
      const response = await fetch('http://localhost:5000/api/packet-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, source: 'SmartAssistant' })
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.statusText}`);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'packet_report.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Error acquiring data:", err);
      setError(err.message);
    } finally {
      setDownloading(false);
    }
  };

  // New button style for a larger, more prominent look
  const bigButtonStyle = {
    width: '80%',
    padding: '20px',
    backgroundColor: '#0f0', // neon green
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

  // Hover effects for the buttons
  const bigButtonHover = {
    scale: 1.1,
    boxShadow: '0 0 30px rgba(0,255,0,1)'
  };

  const inputWrapperStyle = {
    width: '80%',
    margin: '20px auto 0 auto',
    display: 'block',
    height: '56px',
  };

  const passwordWrapperStyle = {
    width: '80%',
    margin: '20px auto 0 auto',
    position: 'relative',
    display: 'block',
    height: '56px',
  };

  const inputStyle = {
    width: '100%',
    boxSizing: 'border-box', // Add this line
    padding: '15px 50px 15px 20px',
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    border: '2px solid #0f0',
    borderRadius: '10px',
    color: '#0f0',
    fontSize: '1.2rem',
    fontFamily: "'Orbitron', sans-serif",
    textAlign: 'center',
    boxShadow: '0 0 10px rgba(0,255,0,0.5)',
    outline: 'none',
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
    padding: 0,
  };

  if (loading) {
    return (
      <div style={containerStyle}>
        <MatrixBackground />
        <TeamInfo teamText={teamText} />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
          <p style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: 24 }}>
            INITIALIZING SMART ASSISTANT...
          </p>
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
        <h1 style={{ ...fancyHeadingStyle, fontSize: '2.5rem', marginBottom: '48px' }}>
          SMART ASSISTANT DATA
        </h1>

        {error && (
          <p style={{ color: 'red', fontSize: '1.2rem' }}>{error}</p>
        )}

        {/* Email and Password input fields */}
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
          onClick={handleAcquireData}
          style={bigButtonStyle}
          whileHover={bigButtonHover}
          disabled={downloading}
        >
          {downloading ? 'Acquiring Data...' : 'Acquire Data'}
        </motion.button>

        <motion.button 
          onClick={() => navigate('/iotextractor')}
          style={bigButtonStyle}
          whileHover={bigButtonHover}
        >
          Back to Devices
        </motion.button>
      </motion.div>
    </div>
  );
};

export default SmartAssistant;
