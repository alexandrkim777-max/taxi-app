// Building blocks in the design system's language: big touch targets (44 px minimum, 56 px main
// button), price always in `ink`, `brand` only for the main action and "online".

import { type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { radius, size, space, type, useTheme } from '../theme';

type Variant = keyof typeof type;

export function T({ v = 'body', muted, color, style, children, center, numberOfLines }: {
  v?: Variant; muted?: boolean; color?: string; style?: TextStyle; children: ReactNode; center?: boolean; numberOfLines?: number;
}) {
  const { c } = useTheme();
  const s = type[v];
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[{ fontSize: s.fontSize, lineHeight: s.lineHeight, fontWeight: s.fontWeight as TextStyle['fontWeight'], color: color ?? (muted ? c.inkMuted : c.ink), fontVariant: ['tabular-nums'] }, center && { textAlign: 'center' }, v === 'label' && { textTransform: 'uppercase', letterSpacing: 0.6 }, style]}
    >
      {children}
    </Text>
  );
}

export function Screen({ children, scroll = true, footer }: { children: ReactNode; scroll?: boolean; footer?: ReactNode }) {
  const { c } = useTheme();
  const body = <View style={{ gap: space.s4, padding: space.s5, paddingTop: space.s6 }}>{children}</View>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.surfacePage }} edges={['top', 'left', 'right']}>
      {scroll ? <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">{body}</ScrollView> : <View style={{ flex: 1 }}>{body}</View>}
      {footer && <View style={{ padding: space.s5, paddingTop: space.s3, gap: space.s2, backgroundColor: c.surfacePage }}>{footer}</View>}
    </SafeAreaView>
  );
}

export function Button({ title, onPress, kind = 'primary', disabled, busy, compact }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'ghost'; disabled?: boolean; busy?: boolean; compact?: boolean;
}) {
  const { c } = useTheme();
  const bg = kind === 'primary' ? c.brand : kind === 'danger' ? c.danger : kind === 'ghost' ? 'transparent' : c.surfaceCard;
  const fg = kind === 'primary' ? c.onBrand : kind === 'danger' ? c.surfaceCard : c.ink;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [{
        minHeight: compact ? size.touchMin : size.buttonMain, borderRadius: radius.pill, paddingHorizontal: space.s5,
        alignItems: 'center', justifyContent: 'center', backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        borderWidth: kind === 'secondary' ? 1 : 0, borderColor: c.border,
      }]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <T v="bodyStrong" color={fg}>{title}</T>}
    </Pressable>
  );
}

export function Card({ children, style, tone }: { children: ReactNode; style?: ViewStyle; tone?: 'brand' | 'warm' | 'sunken' }) {
  const { c } = useTheme();
  const bg = tone === 'brand' ? c.brand : tone === 'warm' ? c.warmTint : tone === 'sunken' ? c.surfaceSunken : c.surfaceCard;
  return <View style={[{ backgroundColor: bg, borderRadius: radius.lg, padding: space.s4, gap: space.s2, borderWidth: tone ? 0 : StyleSheet.hairlineWidth, borderColor: c.border }, style]}>{children}</View>;
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'bad' | 'warm' | 'brand' }) {
  const { c } = useTheme();
  const map = { neutral: [c.surfaceSunken, c.ink], ok: [c.surfaceSunken, c.success], bad: [c.surfaceSunken, c.danger], warm: [c.warmTint, c.warmInk], brand: [c.brand, c.onBrand] } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 }}>
      <T v="label" color={fg} style={{ textTransform: 'none', letterSpacing: 0 }}>{children}</T>
    </View>
  );
}

export function Field({ label, value, onChangeText, keyboardType, placeholder, maxLength, autoFocus, autoCapitalize }: {
  label: string; value: string; onChangeText: (v: string) => void; keyboardType?: 'default' | 'phone-pad' | 'number-pad';
  placeholder?: string; maxLength?: number; autoFocus?: boolean; autoCapitalize?: 'none' | 'words' | 'characters';
}) {
  const { c } = useTheme();
  return (
    <View style={{ gap: space.s1 }}>
      <T v="caption" muted>{label}</T>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor={c.inkMuted}
        maxLength={maxLength}
        autoFocus={autoFocus}
        autoCapitalize={autoCapitalize}
        style={{ minHeight: size.buttonMain, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceCard, paddingHorizontal: space.s4, color: c.ink, fontSize: 17 }}
      />
    </View>
  );
}

export function Seg<V extends string>({ value, options, onChange }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s1, padding: 3, borderRadius: radius.pill, backgroundColor: c.surfaceSunken, alignSelf: 'flex-start' }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onChange(o.value)}
            style={{ minHeight: 40, paddingHorizontal: space.s4, borderRadius: radius.pill, justifyContent: 'center', backgroundColor: on ? c.surfaceCard : 'transparent' }}>
            <T v="bodyStrong" muted={!on}>{o.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Row({ children, gap = space.s2, style }: { children: ReactNode; gap?: number; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap, flexWrap: 'wrap' }, style]}>{children}</View>;
}

export function Divider() {
  const { c } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />;
}

/** The thin band of Uzbek tilework used across the brand. */
export function Tiles() {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden' }}>
      {Array.from({ length: 24 }).map((_, i) => (
        <View key={i} style={{ flex: i % 3 === 2 ? 0.4 : 1, backgroundColor: i % 3 === 0 ? c.brand : i % 3 === 1 ? c.warm : c.surfaceSunken }} />
      ))}
    </View>
  );
}

export function ErrorNote({ text }: { text: string | null }) {
  const { c } = useTheme();
  if (!text) return null;
  return <View style={{ backgroundColor: c.warmTint, borderRadius: radius.sm, padding: space.s3 }}><T color={c.danger}>{text}</T></View>;
}
