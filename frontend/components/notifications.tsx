'use client';

import { useEffect, useRef } from 'react';
import { ToastContainer, toast } from 'react-toastify';
import { useLanguage } from '@/components/language';

export function ToastNotifications() {
  return (
    <ToastContainer
      position="top-right"
      autoClose={3500}
      newestOnTop
      closeOnClick
      pauseOnFocusLoss
      draggable
      pauseOnHover
      theme="colored"
      limit={4}
    />
  );
}

export function useToastNotifications(message: string, error: string) {
  const { t } = useLanguage();
  const previous = useRef({ message: '', error: '' });

  useEffect(() => {
    if (message && message !== previous.current.message) toast.success(t(message));
    if (error && error !== previous.current.error) toast.error(t(error));
    previous.current = { message, error };
  }, [error, message, t]);
}
