/**
 * Device sync settings.
 *
 * Configures the `/sync` endpoint this device talks to, shows what the last sync did, and
 * offers a manual trigger. Once set up, syncing is automatic — see store/syncStore.ts
 * (push, debounced off every write) and app/providers/SyncProvider.tsx (pull, polled).
 *
 * The setup code exists because the alternative is typing a 64-character key into a
 * phone: the configured device copies `url|space|secret` to the clipboard as one string
 * and the second device pastes it.
 */
import React, { useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { useTheme } from '../../../shared/theme';
import { Badge, Button, HStack, Switch, Text, TextField, VStack } from '../../../shared/ui';
import { useFormSubmit } from '../../../shared/hooks';
import { useSyncStore } from '../../../store';
import type { BadgeTone } from '../../../shared/ui';
import type { SyncPhase } from '../../../domain/types/sync';

const SETUP_CODE_PREFIX = 'tutordisco-sync:v1:';

const PHASE_LABEL: Record<SyncPhase, string> = {
  unconfigured: 'Not set up',
  idle: 'Up to date',
  syncing: 'Syncing…',
  error: 'Needs attention',
};

const PHASE_TONE: Record<SyncPhase, BadgeTone> = {
  unconfigured: 'neutral',
  idle: 'success',
  syncing: 'info',
  error: 'danger',
};

const relativeTime = (epochMs: number, nowMs: number): string => {
  const seconds = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(epochMs).toLocaleString();
};

/** `url|space|secret` — no base64, since React Native has no dependable btoa. */
const encodeSetupCode = (url: string, space: string, secret: string): string =>
  `${SETUP_CODE_PREFIX}${url}|${space}|${secret}`;

const decodeSetupCode = (
  code: string,
): { url: string; space: string; secret: string } | null => {
  const trimmed = code.trim();
  if (!trimmed.startsWith(SETUP_CODE_PREFIX)) return null;
  const body = trimmed.slice(SETUP_CODE_PREFIX.length);
  // Split on the first two separators only, so a secret containing '|' survives.
  const firstBar = body.indexOf('|');
  const secondBar = body.indexOf('|', firstBar + 1);
  if (firstBar < 1 || secondBar < firstBar + 2) return null;
  const url = body.slice(0, firstBar);
  const space = body.slice(firstBar + 1, secondBar);
  const secret = body.slice(secondBar + 1);
  if (!url || !space || !secret) return null;
  return { url, space, secret };
};

/** Default endpoint guess: on web the app is served by the very worker that hosts /sync. */
const defaultUrl = (): string => {
  if (Platform.OS !== 'web' || typeof location === 'undefined') return '';
  return `${location.origin}/sync`;
};

export const SyncSection = () => {
  const theme = useTheme();

  const config = useSyncStore((s) => s.config);
  const enabled = useSyncStore((s) => s.enabled);
  const phase = useSyncStore((s) => s.phase);
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const lastStats = useSyncStore((s) => s.lastStats);
  const storeError = useSyncStore((s) => s.error);
  const saveConfig = useSyncStore((s) => s.saveConfig);
  const setEnabled = useSyncStore((s) => s.setEnabled);
  const testConnection = useSyncStore((s) => s.testConnection);
  const syncNow = useSyncStore((s) => s.syncNow);
  const disconnect = useSyncStore((s) => s.disconnect);

  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState('');
  const [space, setSpace] = useState('');
  const [secret, setSecret] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const { submitting, error: formError, setError, submit } = useFormSubmit();

  // The form is toggled rather than mounted fresh, so its fields must re-sync here — a
  // useState initializer would only run once and show stale values (see CLAUDE.md gotchas).
  useEffect(() => {
    if (!showForm) return;
    setUrl(config?.url ?? defaultUrl());
    setSpace(config?.space ?? 'default');
    setSecret(config?.secret ?? '');
    setNotice(null);
    setError(null);
  }, [showForm, config, setError]);

  const handleSave = async () => {
    await submit(
      () => saveConfig({ url, space, secret }),
      () => {
        setShowForm(false);
        setNotice('Sync settings saved.');
        void setEnabled(true);
        void syncNow();
      },
    );
  };

  const handleTest = async () => {
    await submit(testConnection, (meta) => {
      setNotice(
        meta.rev === 0
          ? 'Connected. Nothing has been synced into this space yet.'
          : `Connected. The space is at revision ${meta.rev}.`,
      );
    });
  };

  /**
   * Browsers can refuse clipboard access outright (permission denied, insecure context),
   * and it throws rather than returning an error — so every clipboard call is guarded.
   */
  const copyToClipboard = async (value: string, onCopied: string): Promise<void> => {
    try {
      await Clipboard.setStringAsync(value);
      setNotice(onCopied);
    } catch {
      setError('Could not use the clipboard. Copy the values by hand instead.');
    }
  };

  const handleGenerateKey = async () => {
    const generated = `${Crypto.randomUUID()}${Crypto.randomUUID()}`.replace(/-/g, '');
    setSecret(generated);
    await copyToClipboard(
      generated,
      'New key generated and copied. Set the same value as SYNC_SECRET on your deployment.',
    );
  };

  const handleCopySetupCode = async () => {
    if (config === null) return;
    await copyToClipboard(
      encodeSetupCode(config.url, config.space, config.secret),
      'Setup code copied. Paste it into this screen on your other device.',
    );
  };

  const handlePasteSetupCode = async () => {
    let clipboard: string;
    try {
      clipboard = await Clipboard.getStringAsync();
    } catch {
      setError('Could not read the clipboard. Fill the fields in by hand instead.');
      return;
    }
    const decoded = decodeSetupCode(clipboard);
    if (decoded === null) {
      setError('That clipboard content is not a TutorDisco setup code.');
      return;
    }
    setUrl(decoded.url);
    setSpace(decoded.space);
    setSecret(decoded.secret);
    setNotice('Setup code read from the clipboard. Save to finish.');
  };

  const handleSyncNow = async () => {
    setNotice(null);
    await syncNow();
  };

  const handleDisconnect = async () => {
    await disconnect();
    setNotice('This device will no longer sync. Your data here is untouched.');
  };

  return (
    <VStack gap={theme.space.lg}>
      <HStack gap={theme.space.sm} align="center">
        <Text variant="title">Device Sync</Text>
        <Badge label={PHASE_LABEL[phase]} tone={PHASE_TONE[phase]} />
      </HStack>

      <Text color="textMuted">
        Keep this device and your others in step through your own deployment. Each change is
        merged row by row, so you can edit on either device — the most recent edit to a record
        wins.
      </Text>

      {config !== null && (
        <VStack gap={theme.space.sm}>
          <Text color="textMuted" variant="label">
            Syncing space <Text variant="bodyStrong">{config.space}</Text>
            {lastSyncedAt !== null ? ` · last synced ${relativeTime(lastSyncedAt, Date.now())}` : ''}
          </Text>

          {lastStats !== null && (
            <Text color="textSubtle" variant="caption">
              {lastStats.fromRemote === 0 && lastStats.toRemote === 0
                ? 'Everything already matched.'
                : `Received ${lastStats.fromRemote} change${lastStats.fromRemote === 1 ? '' : 's'}, sent ${lastStats.toRemote}.`}
            </Text>
          )}

          <Switch
            value={enabled}
            onValueChange={(v) => void setEnabled(v)}
            label="Sync automatically"
            description="Push a few seconds after each change, and check for other devices' changes periodically."
          />

          <HStack gap={theme.space.sm}>
            <Button
              label={phase === 'syncing' ? 'Syncing…' : 'Sync now'}
              variant="primary"
              loading={phase === 'syncing'}
              onPress={() => void handleSyncNow()}
            />
            <Button
              label="Copy setup code"
              variant="secondary"
              onPress={() => void handleCopySetupCode()}
            />
          </HStack>
        </VStack>
      )}

      {storeError !== null && <Text color="danger">{storeError}</Text>}
      {notice !== null && <Text color="success">{notice}</Text>}

      {!showForm ? (
        <HStack gap={theme.space.sm}>
          <Button
            label={config === null ? 'Set up sync…' : 'Edit sync settings…'}
            variant={config === null ? 'primary' : 'ghost'}
            onPress={() => setShowForm(true)}
          />
          {config !== null && (
            <Button label="Disconnect" variant="ghost" onPress={() => void handleDisconnect()} />
          )}
        </HStack>
      ) : (
        <VStack gap={theme.space.md}>
          <Button
            label="Paste setup code from clipboard"
            variant="secondary"
            onPress={() => void handlePasteSetupCode()}
          />
          <Text color="textSubtle" variant="caption">
            Already set up another device? Copy its setup code and paste it here instead of
            filling these in by hand.
          </Text>

          <TextField
            label="Sync URL"
            value={url}
            onChangeText={setUrl}
            placeholder="https://your-app.workers.dev/sync"
            autoCapitalize="none"
            autoCorrect={false}
            helperText="Your deployment's address with /sync on the end."
          />
          <TextField
            label="Space"
            value={space}
            onChangeText={setSpace}
            placeholder="default"
            autoCapitalize="none"
            autoCorrect={false}
            helperText="Devices sharing a space share their data. Letters, digits, - and _ only."
          />
          <TextField
            label="Sync key"
            value={secret}
            onChangeText={setSecret}
            placeholder="Matches SYNC_SECRET on your deployment"
            autoCapitalize="none"
            autoCorrect={false}
            helperText="Stored only on this device. Anyone with this key can read and overwrite your synced data."
          />
          <Button
            label="Generate a key"
            variant="ghost"
            onPress={() => void handleGenerateKey()}
          />

          {formError !== null && <Text color="danger">{formError}</Text>}

          <HStack gap={theme.space.sm}>
            <Button
              label={submitting ? 'Saving…' : 'Save'}
              variant="primary"
              loading={submitting}
              disabled={!url.trim() || !space.trim() || !secret.trim()}
              onPress={() => void handleSave()}
            />
            <Button
              label="Test connection"
              variant="secondary"
              disabled={config === null}
              onPress={() => void handleTest()}
            />
            <Button label="Cancel" variant="ghost" onPress={() => setShowForm(false)} />
          </HStack>
        </VStack>
      )}
    </VStack>
  );
};
