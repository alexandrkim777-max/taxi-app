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

export function Field({ label, value, onChangeText, keyboardType, placeholder, maxLength, autoFocus, autoCapitalize, multiline }: {
  label: string; value: string; onChangeText: (v: string) => void; keyboardType?: 'default' | 'phone-pad' | 'number-pad';
  placeholder?: string; maxLength?: number; autoFocus?: boolean; autoCapitalize?: 'none' | 'words' | 'characters' | 'sentences'; multiline?: boolean;
}) {
  const { c } = useTheme();
  return (
    <View style={{ gap: space.s1 }}>
      {label ? <T v="caption" muted>{label}</T> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor={c.inkMuted}
        maxLength={maxLength}
        autoFocus={autoFocus}
        autoCapitalize={autoCapitalize}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={{ minHeight: multiline ? 96 : size.buttonMain, paddingVertical: multiline ? space.s3 : 0, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceCard, paddingHorizontal: space.s4, color: c.ink, fontSize: 17 }}
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

export function Chip({ label, selected, onPress, tone }: { label: string; selected?: boolean; onPress?: () => void; tone?: 'warm' }) {
  const { c } = useTheme();
  const bg = selected ? c.brand : tone === 'warm' ? c.warmTint : c.surfaceCard;
  const fg = selected ? c.onBrand : tone === 'warm' ? c.warmInk : c.ink;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: !!selected }} onPress={onPress} disabled={!onPress}
      style={({ pressed }) => ({ minHeight: 40, paddingHorizontal: space.s4, borderRadius: radius.pill, justifyContent: 'center',
        backgroundColor: bg, borderWidth: selected ? 0 : 1, borderColor: c.border, opacity: pressed ? 0.85 : 1 })}>
      <T v="bodyStrong" color={fg}>{label}</T>
    </Pressable>
  );
}

/** A tappable row: title, optional subtitle, something on the right. */
export function ListRow({ title, subtitle, right, onPress, lead }: {
  title: string; subtitle?: string | null; right?: ReactNode; onPress?: () => void; lead?: ReactNode;
}) {
  const { c } = useTheme();
  return (
    <Pressable accessibilityRole={onPress ? 'button' : undefined} disabled={!onPress} onPress={onPress}
      style={({ pressed }) => ({ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: space.s3, paddingVertical: space.s2, opacity: pressed ? 0.7 : 1 })}>
      {lead}
      <View style={{ flex: 1, gap: 2 }}>
        <T v="bodyStrong" numberOfLines={1}>{title}</T>
        {subtitle ? <T v="caption" muted numberOfLines={1}>{subtitle}</T> : null}
      </View>
      {right ?? (onPress ? <T muted color={c.inkMuted}>›</T> : null)}
    </Pressable>
  );
}

/** Round icon-like badge with one or two characters (no icon font needed). */
export function Badge({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'brand' | 'ink' }) {
  const { c } = useTheme();
  const bg = tone === 'brand' ? c.brand : tone === 'ink' ? c.ink : c.surfaceSunken;
  const fg = tone === 'brand' ? c.onBrand : tone === 'ink' ? c.surfaceCard : c.ink;
  return (
    <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <T v="bodyStrong" color={fg}>{text}</T>
    </View>
  );
}

/** Screen header with a back button. */
export function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <Row gap={space.s3} style={{ flexWrap: 'nowrap' }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={8}
        style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}>
        <T v="title">‹</T>
      </Pressable>
      <T v="title" numberOfLines={1} style={{ flex: 1 }}>{title}</T>
    </Row>
  );
}

/** The bottom panel over the map. */
export function Sheet({ children, onLayoutHeight }: { children: ReactNode; onLayoutHeight?: (h: number) => void }) {
  const { c } = useTheme();
  return (
    <View onLayout={(e) => onLayoutHeight?.(e.nativeEvent.layout.height)}
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '78%', backgroundColor: c.surfacePage,
        borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingTop: space.s2,
        shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: -4 }, elevation: 12 }}>
      <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: space.s2 }} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.s5, paddingBottom: space.s5, gap: space.s3 }} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </View>
  );
}

export function Stars({ value, onChange, size: s = 44 }: { value: number; onChange?: (v: number) => void; size?: number }) {
  const { c } = useTheme();
  return (
    <Row gap={space.s1} style={{ flexWrap: 'nowrap' }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Pressable key={n} accessibilityRole="button" accessibilityLabel={`${n}`} disabled={!onChange} onPress={() => onChange?.(n)}
          style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: s * 0.75, color: n <= value ? c.warm : c.border }}>★</Text>
        </Pressable>
      ))}
    </Row>
  );
}

/** Big plate number, the way passengers look for their car. */
export function Plate({ text }: { text: string }) {
  const { c } = useTheme();
  return (
    <View style={{ alignSelf: 'flex-start', borderWidth: 2, borderColor: c.ink, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: c.surfaceCard }}>
      <T v="price" style={{ letterSpacing: 1 }}>{text}</T>
    </View>
  );
}

export function Progress({ pct }: { pct: number }) {
  const { c } = useTheme();
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: c.surfaceSunken, overflow: 'hidden' }}>
      <View style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: 8, borderRadius: 4, backgroundColor: c.brand }} />
    </View>
  );
}
