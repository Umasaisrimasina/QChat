import { useEffect, useMemo, useRef, useState } from 'react';

const formatDuration = (totalSeconds) => {
  const hours = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, '0');
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, '0');

  return `${hours}:${minutes}:${seconds}`;
};

export const useCallTimer = () => {
  const [seconds, setSeconds] = useState(0);
  const intervalRef = useRef(null);

  const stop = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const start = () => {
    if (intervalRef.current) {
      return;
    }

    intervalRef.current = setInterval(() => {
      setSeconds((current) => current + 1);
    }, 1000);
  };

  const reset = () => {
    setSeconds(0);
  };

  useEffect(() => {
    return () => {
      stop();
    };
  }, []);

  const formatted = useMemo(() => formatDuration(seconds), [seconds]);

  return {
    seconds,
    formatted,
    start,
    stop,
    reset,
  };
};
