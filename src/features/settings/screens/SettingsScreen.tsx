import React, { useEffect, useState } from 'react';
import { Platform, ScrollView, TextInput } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTheme } from '../../../shared/theme';
import { useResponsive } from '../../../shared/responsive';
import { Button, HStack, Text, VStack } from '../../../shared/ui';
import { useBackupStore } from '../../../store/backupStore';
import { useAuthStore, useSettingsStore } from '../../../store';
import { pickBackupFileOnWeb } from '../../../shared/utils/backupFile';
import { SyncSection } from '../components/SyncSection';
import type { ThemePreference } from '../../../domain/types';
import { Select } from '../../../shared/ui';
import type { RootStackParamList } from '../../../app/navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export const SettingsScreen = (_: Props) => {
  const theme = useTheme();
  const { select } = useResponsive();

  const [pastedJson, setPastedJson] = useState('');
  const [showRestore, setShowRestore] = useState(false);
  const [restoreSuccess, setRestoreSuccess] = useState(false);

  const exporting = useBackupStore((s) => s.exporting);
  const restoring = useBackupStore((s) => s.restoring);
  const error = useBackupStore((s) => s.error);
  const exportData = useBackupStore((s) => s.exportData);
  const restoreFromJson = useBackupStore((s) => s.restoreFromJson);
  const clearError = useBackupStore((s) => s.clearError);

  const currentAccount = useAuthStore((s) => s.currentAccount);

  const themePref = useSettingsStore((s) => s.theme);
  const loadSettings = useSettingsStore((s) => s.load);
  const setTheme = useSettingsStore((s) => s.setTheme);

  const maxWidth = select({ compact: 9999, expanded: 800 });

  const themeOptions: { label: string; value: ThemePreference }[] = [
    { label: 'System default', value: 'system' },
    { label: 'Light', value: 'light' },
    { label: 'Dark', value: 'dark' },
  ];

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleExport = async () => {
    await exportData();
  };

  const handlePickFile = async () => {
    const content = await pickBackupFileOnWeb();
    if (content !== null) setPastedJson(content);
  };

  const handleRestore = async () => {
    const trimmed = pastedJson.trim();
    if (!trimmed) return;
    const result = await restoreFromJson(trimmed);
    if (result.ok) {
      setPastedJson('');
      setShowRestore(false);
      setRestoreSuccess(true);
    }
  };

  const openRestore = () => {
    setShowRestore(true);
    setRestoreSuccess(false);
    clearError();
  };

  const closeRestore = () => {
    setShowRestore(false);
    setPastedJson('');
    clearError();
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{ alignItems: 'center' }}
      keyboardShouldPersistTaps="handled"
    >
      <VStack gap={theme.space.xl} style={{ width: '100%', maxWidth, padding: theme.space.lg }}>
        {currentAccount && (
          <VStack gap={theme.space.xs}>
            <Text variant="title">Account</Text>
            <Text color="textMuted">
              Signed in as <Text variant="bodyStrong">{currentAccount.displayName}</Text>
            </Text>
            <Text color="textSubtle" variant="label">
              @{currentAccount.username}
            </Text>
          </VStack>
        )}

        <VStack gap={theme.space.sm}>
          <Text variant="title">Appearance</Text>
          <Select
            label="Theme"
            value={themePref}
            options={themeOptions}
            onChange={(v) => void setTheme(v)}
          />
        </VStack>

        <SyncSection />

        <VStack gap={theme.space.lg}>
          <Text variant="title">Data Backup</Text>

          {/* Export */}
          <VStack gap={theme.space.sm}>
            <Text variant="bodyStrong">Export</Text>
            <Text color="textMuted">
              Save a copy of all your tutoring data as a JSON file. Store it somewhere safe — you can restore from it at any time.
            </Text>
            <Button
              label={exporting ? 'Exporting…' : 'Export Backup'}
              variant="primary"
              loading={exporting}
              onPress={() => void handleExport()}
            />
          </VStack>

          {/* Restore */}
          <VStack gap={theme.space.sm}>
            <Text variant="bodyStrong">Restore</Text>
            <Text color="textMuted">
              Restore all data from a previous backup. Your current data will be replaced.
            </Text>

            {!showRestore ? (
              <VStack gap={theme.space.sm}>
                <Button
                  label="Restore from Backup"
                  variant="secondary"
                  onPress={openRestore}
                />
                {restoreSuccess && (
                  <Text color="success">Backup restored successfully.</Text>
                )}
              </VStack>
            ) : (
              <VStack gap={theme.space.md}>
                <VStack
                  gap={theme.space.xs}
                  style={{
                    backgroundColor: theme.colors.dangerMuted,
                    borderRadius: theme.radii.md,
                    padding: theme.space.md,
                  }}
                >
                  <Text color="danger" variant="label" weight="600">
                    Warning
                  </Text>
                  <Text color="danger" variant="label">
                    All current data will be permanently replaced with the backup contents. This cannot be undone.
                  </Text>
                </VStack>

                {Platform.OS === 'web' && (
                  <Button
                    label="Choose backup file…"
                    variant="ghost"
                    onPress={() => void handlePickFile()}
                  />
                )}

                <Text color="textMuted" variant="caption">
                  {Platform.OS === 'web'
                    ? 'Or paste the backup JSON below:'
                    : 'Open your backup file, copy all the text, and paste it here:'}
                </Text>

                <TextInput
                  value={pastedJson}
                  onChangeText={setPastedJson}
                  multiline
                  placeholder="Paste backup JSON here…"
                  placeholderTextColor={theme.colors.textSubtle}
                  textAlignVertical="top"
                  style={{
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    borderRadius: theme.radii.md,
                    padding: theme.space.md,
                    color: theme.colors.text,
                    backgroundColor: theme.colors.surface,
                    minHeight: 140,
                    fontSize: 13,
                    fontFamily: Platform.select({
                      ios: 'Menlo',
                      android: 'monospace',
                      default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    }),
                  }}
                />

                {error !== null && <Text color="danger">{error}</Text>}

                <HStack gap={theme.space.sm}>
                  <Button
                    label={restoring ? 'Restoring…' : 'Restore'}
                    variant="primary"
                    loading={restoring}
                    disabled={!pastedJson.trim()}
                    onPress={() => void handleRestore()}
                  />
                  <Button label="Cancel" variant="ghost" onPress={closeRestore} />
                </HStack>
              </VStack>
            )}
          </VStack>
        </VStack>
      </VStack>
    </ScrollView>
  );
};
