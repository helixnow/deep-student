import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import './LoadingScreen.css';

interface LoadingScreenProps {
  isLoading: boolean;
  loadingText?: string;
  progress?: number;
}

// Animation variants
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      duration: 0.3,
      staggerChildren: 0.15,
      delayChildren: 0.1
    }
  },
  exit: {
    opacity: 0,
    transition: {
      duration: 0.4,
      ease: 'easeInOut' as const
    }
  }
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      type: 'spring' as const,
      stiffness: 300,
      damping: 24
    }
  }
};

const logoVariants = {
  hidden: { opacity: 0, scale: 0.8 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      type: 'spring' as const,
      stiffness: 200,
      damping: 20
    }
  }
};

const spinnerVariants = {
  hidden: { opacity: 0, scale: 0.5 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      type: 'spring' as const,
      stiffness: 300,
      damping: 20
    }
  }
};

const stepVariants = {
  hidden: { opacity: 0, x: -10 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: {
      delay: i * 0.1,
      type: 'spring' as const,
      stiffness: 300,
      damping: 24
    }
  })
};

// Animated spinner component
const AnimatedSpinner: React.FC = () => {
  return (
    <div className="spinner">
      <motion.div
        className="spinner-ring"
        animate={{ rotate: 360 }}
        transition={{
          duration: 1.2,
          ease: 'linear',
          repeat: Infinity
        }}
      />
      <motion.div
        className="spinner-pulse"
        animate={{
          scale: [1, 1.2, 1],
          opacity: [0.3, 0.6, 0.3]
        }}
        transition={{
          duration: 1.5,
          ease: 'easeInOut',
          repeat: Infinity
        }}
      />
    </div>
  );
};

const LoadingScreen: React.FC<LoadingScreenProps> = ({
  isLoading,
  loadingText,
  progress
}) => {
  const { t } = useTranslation('common');
  const [dots, setDots] = useState('');
  const [activeStep, setActiveStep] = useState(0);

  const displayText = loadingText || t('loadingScreen.initializing', '正在初始化...');

  useEffect(() => {
    if (!isLoading) return;

    const dotsInterval = setInterval(() => {
      setDots(prev => {
        if (prev.length >= 3) return '';
        return prev + '.';
      });
    }, 400);

    return () => clearInterval(dotsInterval);
  }, [isLoading]);

  // Animate loading steps based on progress or time
  useEffect(() => {
    if (!isLoading) return;

    const stepInterval = setInterval(() => {
      setActiveStep(prev => (prev < 2 ? prev + 1 : prev));
    }, 800);

    return () => clearInterval(stepInterval);
  }, [isLoading]);

  const loadingSteps = useMemo(() => [
    { icon: '✓', text: t('loadingScreen.step_config', '加载配置') },
    { icon: '⚡', text: t('loadingScreen.step_database', '初始化数据库') },
    { icon: '🚀', text: t('loadingScreen.step_ui', '准备界面') }
  ], [t]);

  return (
    <AnimatePresence mode="wait">
      {isLoading && (
        <motion.div
          className="loading-screen"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          <motion.div className="loading-content" variants={containerVariants}>
            {/* Logo */}
            <motion.div className="loading-logo" variants={logoVariants}>
              <motion.div
                className="logo-icon"
                animate={{
                  y: [0, -6, 0]
                }}
                transition={{
                  duration: 2,
                  ease: 'easeInOut',
                  repeat: Infinity
                }}
              >
                <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="32" cy="32" r="30" fill="url(#gradient)" />
                  <path d="M20 28h24v8H20z" fill="white" opacity="0.9" />
                  <path d="M24 20h16v4H24z" fill="white" opacity="0.7" />
                  <path d="M24 40h16v4H24z" fill="white" opacity="0.7" />
                  <defs>
                    <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#3b82f6" />
                      <stop offset="100%" stopColor="#1d4ed8" />
                    </linearGradient>
                  </defs>
                </svg>
              </motion.div>
              <motion.h1
                className="app-title"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2, duration: 0.4 }}
              >
                Deep Student
              </motion.h1>
            </motion.div>

            {/* Loading Animation */}
            <motion.div
              className="loading-animation"
              variants={spinnerVariants}
            >
              <AnimatedSpinner />
            </motion.div>

            {/* Loading Text */}
            <motion.div
              className="loading-text"
              variants={itemVariants}
            >
              <motion.span
                key={displayText}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
              >
                {displayText}{dots}
              </motion.span>
            </motion.div>

            {/* Progress Bar (if provided) */}
            {progress !== undefined && (
              <motion.div
                className="progress-container"
                variants={itemVariants}
              >
                <div className="progress-bar">
                  <motion.div
                    className="progress-fill"
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
                    transition={{
                      type: 'spring',
                      stiffness: 100,
                      damping: 20
                    }}
                  />
                </div>
                <motion.span
                  className="progress-text"
                  key={Math.round(progress)}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {Math.round(progress)}%
                </motion.span>
              </motion.div>
            )}

            {/* Loading Steps */}
            <motion.div
              className="loading-steps"
              variants={itemVariants}
            >
              {loadingSteps.map((step, index) => (
                <motion.div
                  key={index}
                  className={`step ${index <= activeStep ? 'active' : ''}`}
                  custom={index}
                  variants={stepVariants}
                  whileHover={{ scale: 1.05 }}
                >
                  <motion.div
                    className="step-icon"
                    animate={index <= activeStep ? {
                      scale: [1, 1.2, 1],
                      transition: { duration: 0.3 }
                    } : {}}
                  >
                    {step.icon}
                  </motion.div>
                  <span>{step.text}</span>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default LoadingScreen;
