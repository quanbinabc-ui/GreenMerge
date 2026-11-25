import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { PublicVolunteerCertificate, VolunteerCertificate } from '@civicmerge/contracts';
import { api } from '../services/api';
import {
  Badge,
  Body,
  Button,
  Card,
  colors,
  dateLabel,
  ErrorNotice,
  Heading,
  Loading,
  messageOf,
  Page,
  SectionTitle,
  styles,
} from '../ui';

export function CertificatesScreen({
  onOpenEvent,
}: {
  onOpenEvent(eventId: string): void;
}) {
  const [certificates, setCertificates] = useState<VolunteerCertificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lookupCode, setLookupCode] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [lookupResult, setLookupResult] = useState<PublicVolunteerCertificate | null>(null);

  const loadMine = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.myCertificates();
      setCertificates(res.certificates);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadMine();
    }, [loadMine]),
  );

  async function handleLookup() {
    const code = lookupCode.trim().toUpperCase();
    if (!code) return;
    setLookupBusy(true);
    setLookupError('');
    setLookupResult(null);
    try {
      const cert = await api.lookupCertificate(code);
      setLookupResult(cert);
    } catch (err) {
      setLookupError(messageOf(err));
    } finally {
      setLookupBusy(false);
    }
  }

  return (
    <Page>
      <View style={s.headerBox}>
        <Heading>🏅 Giấy Chứng Nhận Xanh</Heading>
        <Text style={styles.caption}>
          Ghi nhận đóng góp tình nguyện cộng đồng và hỗ trợ tra cứu xác thực công khai
        </Text>
      </View>

      <Card>
        <SectionTitle>Tra cứu công khai mã chứng nhận</SectionTitle>
        <View style={s.lookupRow}>
          <TextInput
            accessibilityLabel="Mã giấy chứng nhận"
            placeholder="Ví dụ: GM-2026-XXXXXX"
            value={lookupCode}
            onChangeText={setLookupCode}
            autoCapitalize="characters"
            autoCorrect={false}
            style={[styles.input, s.lookupInput]}
          />
          <Button
            title={lookupBusy ? 'Đang tìm…' : 'Tra cứu'}
            compact
            disabled={lookupBusy || !lookupCode.trim()}
            onPress={() => void handleLookup()}
          />
        </View>
        {!!lookupError && <ErrorNotice message={lookupError} />}
        {lookupResult && (
          <View style={s.certCard}>
            <View style={styles.rowBetween}>
              <Badge tone="success" label="✓ CHỨNG NHẬN HỢP LỆ" />
              <Text style={s.certCode}>{lookupResult.certificateCode}</Text>
            </View>
            <Text style={s.recipientName}>{lookupResult.recipientName}</Text>
            <Body>Đã hoàn thành xuất sắc buổi: {lookupResult.eventTitle}</Body>
            <Text style={styles.caption}>Đơn vị cấp: {lookupResult.issuedBy}</Text>
            <Text style={styles.caption}>Ngày hoàn thành: {dateLabel(lookupResult.completedAt)}</Text>
            <Button
              title="Xem buổi tình nguyện →"
              secondary
              compact
              onPress={() => onOpenEvent(lookupResult.eventId)}
            />
          </View>
        )}
      </Card>

      <View style={styles.rowBetween}>
        <SectionTitle>Chứng nhận của tôi ({certificates.length})</SectionTitle>
        <Button title="🔄 Tải lại" secondary compact disabled={loading} onPress={() => void loadMine()} />
      </View>

      {loading && <Loading label="Đang tải danh sách giấy chứng nhận…" />}
      {!!error && <ErrorNotice message={error} />}

      {!loading && !error && certificates.length === 0 && (
        <Card style={s.emptyCard}>
          <SectionTitle>Bạn chưa có Giấy chứng nhận nào</SectionTitle>
          <Body>
            Hãy tham gia một Buổi Tình Nguyện Xanh và hoàn thành dọn dẹp. Sau khi Ban quản lý duyệt ảnh Sau, Giấy chứng nhận sẽ xuất hiện tại đây.
          </Body>
        </Card>
      )}

      {certificates.map((cert) => (
        <Card key={cert.id} style={s.myCertCard}>
          <View style={styles.rowBetween}>
            <Badge tone="success" label="🌿 TÌNH NGUYỆN XANH" />
            <Text style={s.certCode}>{cert.certificateCode}</Text>
          </View>
          <Text style={s.recipientName}>{cert.recipientName}</Text>
          <Body>{cert.eventTitle}</Body>
          <View style={styles.divider} />
          <Text style={styles.caption}>Cấp bởi: {cert.issuedBy}</Text>
          <Text style={styles.caption}>Ngày cấp: {dateLabel(cert.issuedAt)}</Text>
          <Button
            title="Xem hồ sơ buổi tình nguyện →"
            secondary
            compact
            onPress={() => onOpenEvent(cert.eventId)}
          />
        </Card>
      ))}
    </Page>
  );
}

const s = StyleSheet.create({
  headerBox: { gap: 2 },
  lookupRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  lookupInput: {
    flex: 1,
    minHeight: 42,
    paddingVertical: 8,
    fontSize: 14,
  },
  certCard: {
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.successSoft,
    borderWidth: 1.5,
    borderColor: colors.successBorder,
    gap: 8,
  },
  myCertCard: {
    backgroundColor: colors.successSoft,
    borderColor: colors.successBorder,
    borderWidth: 1.5,
  },
  certCode: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.success,
    backgroundColor: colors.surface,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  recipientName: {
    fontSize: 19,
    fontWeight: '800',
    color: colors.ink,
  },
  emptyCard: {
    alignItems: 'center',
    paddingVertical: 24,
  },
});
