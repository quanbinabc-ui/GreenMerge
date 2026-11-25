import { useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { AIAnalysis, IncidentType, VolunteerEventStatus, VolunteerParticipantStatus } from '@civicmerge/contracts';

export type Severity = AIAnalysis['severity'];

export const colors = {
  background: '#F4F7FB',
  surface: '#FFFFFF',
  surfaceMuted: '#F8FAFC',
  ink: '#0F172A',
  muted: '#475569',
  subtle: '#64748B',
  border: '#E2E8F0',
  primary: '#0284C7',
  primaryDark: '#0369A1',
  soft: '#E0F2FE',
  softBorder: '#BAE6FD',
  success: '#15803D',
  successSoft: '#DCFCE7',
  successBorder: '#86EFAC',
  warning: '#B45309',
  warningSoft: '#FEF3C7',
  warningBorder: '#FCD34D',
  error: '#B91C1C',
  errorSoft: '#FEE2E2',
  errorBorder: '#FCA5A5',
};

export const typeLabels: Record<IncidentType, string> = {
  pothole: 'Ổ gà',
  trash: 'Rác thải',
  flood: 'Ngập nước',
};

export const typeIcons: Record<IncidentType, string> = {
  pothole: '●',
  trash: '●',
  flood: '●',
};

export const severityLabels: Record<Severity, string> = {
  low: 'Thấp',
  medium: 'Trung bình',
  high: 'Cao',
};

export const statusLabels = {
  open: 'Mới tiếp nhận',
  in_progress: 'Đang xử lý',
  resolved: 'Đã xử lý',
};

export const volunteerStatusLabels: Record<VolunteerEventStatus, string> = {
  recruiting: 'Đang tuyển TNV',
  in_progress: 'Đang thực hiện',
  pending_review: 'Chờ duyệt ảnh Sau',
  verified: 'Đã duyệt & Cấp CN',
  cancelled: 'Đã hủy',
};

export const participantStatusLabels: Record<VolunteerParticipantStatus, string> = {
  joined: 'Đã đăng ký',
  checked_in: 'Đã điểm danh',
  certified: 'Đã cấp chứng nhận',
  cancelled: 'Đã hủy',
};

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Đã có lỗi. Hãy thử lại.';

export const dateLabel = (date: string) => new Date(date).toLocaleString('vi-VN');

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
}) {
  const palette = {
    neutral: { bg: colors.surfaceMuted, border: colors.border, text: colors.muted },
    primary: { bg: colors.soft, border: colors.softBorder, text: colors.primaryDark },
    success: { bg: colors.successSoft, border: colors.successBorder, text: colors.success },
    warning: { bg: colors.warningSoft, border: colors.warningBorder, text: colors.warning },
    danger: { bg: colors.errorSoft, border: colors.errorBorder, text: colors.error },
  }[tone];

  return (
    <View style={[styles.badge, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <Text style={[styles.badgeText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

export function TypeBadge({ type }: { type: IncidentType }) {
  const tone = type === 'pothole' ? 'warning' : type === 'trash' ? 'success' : 'primary';
  return <Badge tone={tone} label={`${typeIcons[type]} ${typeLabels[type]}`} />;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const tone = severity === 'high' ? 'danger' : severity === 'medium' ? 'warning' : 'success';
  return <Badge tone={tone} label={`Mức độ: ${severityLabels[severity]}`} />;
}

export function StatusBadge({ status }: { status: keyof typeof statusLabels }) {
  const tone = status === 'resolved' ? 'success' : status === 'in_progress' ? 'warning' : 'primary';
  return <Badge tone={tone} label={statusLabels[status]} />;
}

export function VolunteerStatusBadge({ status }: { status: VolunteerEventStatus }) {
  const tone = status === 'verified'
    ? 'success'
    : status === 'pending_review' || status === 'in_progress'
      ? 'warning'
      : status === 'cancelled'
        ? 'danger'
        : 'primary';
  return <Badge tone={tone} label={volunteerStatusLabels[status]} />;
}

export function StatusStepper({ status }: { status: keyof typeof statusLabels }) {
  const currentIndex = status === 'resolved' ? 2 : status === 'in_progress' ? 1 : 0;
  const steps = ['1. Tiếp nhận', '2. Đang xử lý', '3. Đã xử lý'];
  return (
    <View style={styles.stepperRow}>
      {steps.map((title, idx) => {
        const done = idx < currentIndex;
        const active = idx === currentIndex;
        return (
          <View
            key={title}
            style={[
              styles.stepperItem,
              done && styles.stepperDone,
              active && styles.stepperActive,
            ]}
          >
            <Text
              style={[
                styles.stepperText,
                done && styles.stepperTextDone,
                active && styles.stepperTextActive,
              ]}
            >
              {done ? `✓ ${title}` : title}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function Button({
  title,
  onPress,
  secondary = false,
  tone = 'primary',
  disabled = false,
  compact = false,
}: {
  title: string;
  onPress(): void;
  secondary?: boolean;
  tone?: 'primary' | 'success' | 'warning' | 'danger';
  disabled?: boolean;
  compact?: boolean;
}) {
  const solidBg =
    tone === 'success'
      ? colors.success
      : tone === 'warning'
        ? colors.warning
        : tone === 'danger'
          ? colors.error
          : colors.primary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        secondary ? styles.secondary : { backgroundColor: solidBg },
        { opacity: disabled ? 0.45 : pressed ? 0.78 : 1 },
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          compact && styles.buttonTextCompact,
          secondary && { color: colors.primaryDark },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function Page({ children }: PropsWithChildren) {
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

export function Card({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Heading({ children }: PropsWithChildren) {
  return (
    <Text accessibilityRole="header" style={styles.heading}>
      {children}
    </Text>
  );
}

export function SectionTitle({ children }: PropsWithChildren) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Body({ children }: PropsWithChildren) {
  return <Text style={styles.body}>{children}</Text>;
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <View style={styles.errorBox}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>
        ⚠️ {message}
      </Text>
    </View>
  );
}

export function Loading({ label = 'Đang xử lý dữ liệu…' }: { label?: string }) {
  return (
    <View style={styles.loadingBox}>
      <ActivityIndicator accessibilityLabel="Đang tải" size="large" color={colors.primary} />
      <Text style={styles.caption}>{label}</Text>
    </View>
  );
}

export function Photo({
  uri,
  label,
  compact = false,
  overlayLabel,
}: {
  uri: string;
  label: string;
  compact?: boolean;
  overlayLabel?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  return (
    <View style={styles.photoContainer}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Xem phóng to: ${label}`}
        disabled={failed}
        onPress={() => setViewerOpen(true)}
        style={({ pressed }) => [styles.photoFrame, { opacity: pressed && !failed ? 0.88 : 1 }]}
      >
        <Image
          accessibilityLabel={label}
          source={{ uri }}
          resizeMode="cover"
          style={[styles.photo, compact && styles.photoCompact]}
          onLoad={() => setFailed(false)}
          onError={() => setFailed(true)}
        />
        {overlayLabel && !failed && (
          <View style={styles.photoOverlay}>
            <Text style={styles.photoOverlayText}>{overlayLabel}</Text>
          </View>
        )}
      </Pressable>
      <Text style={styles.caption} numberOfLines={compact ? 2 : undefined}>
        {label}{!failed && !compact ? ' · Chạm để phóng to' : ''}
      </Text>
      {failed && (
        <ErrorNotice message="Không tải được ảnh. Kiểm tra URL ảnh và kết nối API." />
      )}
      <Modal
        visible={viewerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setViewerOpen(false)}
      >
        <View style={styles.lightboxBackdrop}>
          <View style={styles.lightboxHeader}>
            <Text style={styles.lightboxCaption} numberOfLines={2}>{label}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Đóng ảnh phóng to"
              onPress={() => setViewerOpen(false)}
              style={({ pressed }) => [styles.lightboxClose, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={styles.lightboxCloseText}>✕ Đóng</Text>
            </Pressable>
          </View>
          <ScrollView
            style={styles.lightboxScroll}
            contentContainerStyle={styles.lightboxContent}
            maximumZoomScale={3}
            minimumZoomScale={1}
            centerContent
          >
            <Image
              accessibilityLabel={label}
              source={{ uri }}
              resizeMode="contain"
              style={styles.lightboxImage}
            />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

export const styles = StyleSheet.create({
  input: { minHeight: 48, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, color: colors.ink, backgroundColor: colors.surface, fontSize: 16 },
  page: {
    padding: 16,
    gap: 14,
    paddingBottom: 44,
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
  },
  card: {
    padding: 16,
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  heading: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.3,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink,
  },
  caption: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
  },
  errorBox: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.errorSoft,
    borderWidth: 1,
    borderColor: colors.errorBorder,
  },
  error: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
    color: colors.error,
  },
  loadingBox: {
    paddingVertical: 16,
    alignItems: 'center',
    gap: 8,
  },
  button: {
    minHeight: 48,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonCompact: {
    minHeight: 38,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  secondary: {
    backgroundColor: colors.soft,
    borderColor: colors.softBorder,
    borderWidth: 1,
  },
  buttonText: {
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '700',
    color: colors.surface,
  },
  buttonTextCompact: {
    fontSize: 13,
    fontWeight: '600',
  },
  photoContainer: {
    gap: 6,
  },
  photoFrame: {
    position: 'relative',
  },
  photo: {
    width: '100%',
    aspectRatio: 1.7,
    borderRadius: 12,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  photoCompact: {
    aspectRatio: 1.15,
  },
  photoOverlay: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
  },
  photoOverlayText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  stepperRow: {
    flexDirection: 'row',
    gap: 6,
  },
  stepperItem: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
  },
  stepperDone: {
    backgroundColor: colors.successSoft,
    borderColor: colors.successBorder,
  },
  stepperActive: {
    backgroundColor: colors.soft,
    borderColor: colors.primary,
  },
  stepperText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.subtle,
    textAlign: 'center',
  },
  stepperTextDone: {
    color: colors.success,
  },
  stepperTextActive: {
    color: colors.primaryDark,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  rowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  gridTwo: {
    flexDirection: 'row',
    gap: 10,
  },
  flexOne: {
    flex: 1,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 2,
  },
  lightboxBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.94)',
    paddingTop: 48,
    paddingBottom: 24,
    paddingHorizontal: 16,
  },
  lightboxHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  lightboxCaption: {
    flex: 1,
    color: '#F8FAFC',
    fontSize: 13,
    lineHeight: 18,
  },
  lightboxClose: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
  },
  lightboxCloseText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  lightboxScroll: {
    flex: 1,
  },
  lightboxContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  lightboxImage: {
    width: '100%',
    height: 460,
  },
});
