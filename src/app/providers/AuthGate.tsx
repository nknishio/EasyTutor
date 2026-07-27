/**
 * AuthGate — decides what the app shows based on auth state.
 *
 * On mount it restores the last active account (if any) and points the data layer at it.
 * While that resolves it shows a spinner; with no account it shows the login/register
 * screens; once authenticated it renders the main app (children).
 */
import React, { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../shared/theme';
import { Spinner } from '../../shared/ui/feedback';
import { useAuthStore } from '../../store';
import { LoginScreen } from '../../features/auth/screens/LoginScreen';
import { RegisterScreen } from '../../features/auth/screens/RegisterScreen';
import { SyncProvider } from './SyncProvider';

export const AuthGate = ({ children }: { children: ReactNode }) => {
  const theme = useTheme();
  const status = useAuthStore((s) => s.status);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const [showRegister, setShowRegister] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (status === 'initializing') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background }}>
        <Spinner size="large" />
      </View>
    );
  }

  if (status === 'unauthenticated') {
    return showRegister ? (
      <RegisterScreen onSwitchToLogin={() => setShowRegister(false)} />
    ) : (
      <LoginScreen onSwitchToRegister={() => setShowRegister(true)} />
    );
  }

  // Sync only runs for a signed-in account — mounting it here keeps its timers off the
  // login screen and tears them down on sign-out.
  return <SyncProvider>{children}</SyncProvider>;
};
