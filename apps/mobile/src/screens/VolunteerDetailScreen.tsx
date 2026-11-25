import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import type { VolunteerEventDetail } from '@civicmerge/contracts';
import { api, imageSourceUrl, type UploadImage } from '../services/api';
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
  participantStatusLabels,
  Photo,
  SectionTitle,
  SeverityBadge,
  StatusBadge,
  styles,
  TypeBadge,
  VolunteerStatusBadge,
} from '../ui';

export function VolunteerDetailScreen({
  id,
  onIncidentDetail,
  onCertificates,
  onBackToList,
}: {
  id: string;
  onIncidentDetail(incidentId: string): void;
  onCertificates(): void;
  onBackToList(): void;
}) {
  const [detail, setDetail] = useState<VolunteerEventDetail | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [pendingAfterImage, setPendingAfterImage] = useState<UploadImage | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    api
      .volunteerEventDetail(id)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((err) => {
        if (active) setError(messageOf(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id, retry]);

  async function runAction(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function pickAfterPhoto(camera: boolean) {
    if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
      throw new Error('Chưa được cấp quyền camera. Bạn có thể chọn ảnh có sẵn từ thư viện.');
    }
    const result = camera
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: false })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, allowsEditing: false });
    if (result.canceled) return;
    const converted = await ImageManipulator.manipulateAsync(
      result.assets[0].uri,
      [{ resize: { width: Math.min(result.assets[0].width, 1600) } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
    );
    setPendingAfterImage({ uri: converted.uri, name: 'after-cleanup.jpg', type: 'image/jpeg' });
  }

  async function uploadAfterPhoto() {
    if (!detail || !pendingAfterImage) return;
    await runAction(async () => {
      const updated = await api.submitVolunteerAfterImage(detail.id, pendingAfterImage);
      setDetail(updated);
      setPendingAfterImage(null);
      setNotice('Đã nộp ảnh Sau thành công! Hồ sơ đang chờ Ban quản lý đánh giá & cấp chứng nhận.');
    });
  }

  const activeParticipants = detail ? detail.participants.filter(p => p.status !== 'cancelled') : [];
  const progressRatio = detail && detail.maxParticipants > 0
    ? Math.min(1, detail.participantCount / detail.maxParticipants)
    : 0;
  const canJoinOrLeave = detail ? detail.status === 'recruiting' || detail.status === 'in_progress' : false;
  const canUploadAfter = detail ? detail.status !== 'verified' && detail.status !== 'cancelled' : false;

  return (
    <Page>
      <View style={s.headerBox}>
        <Heading>🌿 Chi tiết Buổi Tình Nguyện</Heading>
        <Text style={styles.caption}>Mã buổi: #{id.slice(0, 8).toUpperCase()}</Text>
      </View>

      {loading && <Loading label="Đang tải thông tin buổi tình nguyện…" />}
      {!!error && <ErrorNotice message={error} />}
      {!!notice && (
        <Card style={s.noticeCard}>
          <Text style={s.noticeText}>✓ {notice}</Text>
        </Card>
      )}

      {detail && (
        <>
          {detail.status === 'verified' && (
            <Card style={s.verifiedCard}>
              <Badge tone="success" label="🏅 ĐÃ PHÊ DUYỆT & CẤP CHỨNG NHẬN" />
              <Body>
                Ban quản lý ({detail.reviewedBy ?? 'GreenMerge'}) đã xác nhận hoàn thành và tự động đóng sự cố.
              </Body>
              {detail.reviewNote && <Text style={styles.caption}>Nhận xét: {detail.reviewNote}</Text>}
              <Button title="🏅 Xem Giấy Chứng Nhận của tôi" tone="success" onPress={onCertificates} />
            </Card>
          )}

          {detail.status === 'in_progress' && !!detail.reviewNote && (
            <Card style={s.rejectCard}>
              <Badge tone="warning" label="YÊU CẦU BỔ SUNG TỪ BAN QUẢN LÝ" />
              <Body>{detail.reviewNote}</Body>
              <Text style={styles.caption}>Hãy chụp và nộp lại ảnh Sau rõ nét hơn ở mục bên dưới.</Text>
            </Card>
          )}

          <Card>
            <View style={styles.rowBetween}>
              <VolunteerStatusBadge status={detail.status} />
              <Badge tone="primary" label={`👥 ${detail.participantCount}/${detail.maxParticipants} TNV`} />
            </View>
            <Text style={s.title}>{detail.title}</Text>
            {!!detail.description && <Body>{detail.description}</Body>}

            <View style={s.progressTrack}>
              <View style={[s.progressFill, { width: `${Math.round(progressRatio * 100)}%` }]} />
            </View>

            <View style={s.metaList}>
              <Text style={styles.caption}>👤 Trưởng nhóm: {detail.organizerName}</Text>
              <Text style={styles.caption}>📍 Điểm tập trung: {detail.meetingPoint}</Text>
              <Text style={styles.caption}>🕒 Thời gian: {dateLabel(detail.scheduledAt)}</Text>
            </View>

            <View style={s.incidentBox}>
              <View style={styles.rowWrap}>
                <TypeBadge type={detail.incidentSummary.type} />
                <SeverityBadge severity={detail.incidentSummary.severity} />
                <StatusBadge status={detail.incidentSummary.status} />
              </View>
              <Text style={styles.caption}>{detail.incidentSummary.description}</Text>
              <Button
                title="Xem hồ sơ sự cố gốc →"
                secondary
                compact
                onPress={() => onIncidentDetail(detail.incidentSummary.id)}
              />
            </View>
          </Card>

          <Card>
            <SectionTitle>So sánh Trước – Sau (Before / After)</SectionTitle>
            <Photo uri={imageSourceUrl(detail.beforeImageUrl)} label="📷 Ảnh TRƯỚC (Sự cố gốc)" />
            {detail.afterImageUrl ? (
              <Photo uri={imageSourceUrl(detail.afterImageUrl)} label="✨ Ảnh SAU (Tình nguyện viên nộp)" />
            ) : (
              <Text style={styles.caption}>Chưa có ảnh Sau khi hoàn thành.</Text>
            )}
          </Card>

          {canJoinOrLeave && (
            <Card>
              <SectionTitle>Đăng ký tham gia</SectionTitle>
              <TextInput
                accessibilityLabel="Tên hiển thị trên giấy chứng nhận"
                placeholder="Họ tên của bạn (hiển thị trên Giấy chứng nhận)"
                value={displayName}
                onChangeText={setDisplayName}
                editable={!busy}
                style={styles.input}
              />
              <View style={styles.gridTwo}>
                <View style={styles.flexOne}>
                  <Button
                    title={busy ? 'Đang xử lý…' : '✓ Tham gia buổi'}
                    tone="success"
                    disabled={busy || detail.participantCount >= detail.maxParticipants}
                    onPress={() => void runAction(async () => {
                      const updated = await api.joinVolunteerEvent(detail.id, {
                        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
                      });
                      setDetail(updated);
                      setNotice('Đã đăng ký tham gia Buổi Tình Nguyện Xanh!');
                    })}
                  />
                </View>
                <View style={styles.flexOne}>
                  <Button
                    title="Hủy tham gia"
                    secondary
                    disabled={busy}
                    onPress={() => void runAction(async () => {
                      const updated = await api.leaveVolunteerEvent(detail.id);
                      setDetail(updated);
                      setNotice('Đã hủy đăng ký tham gia buổi tình nguyện.');
                    })}
                  />
                </View>
              </View>
            </Card>
          )}

          {canUploadAfter && (
            <Card>
              <SectionTitle>Nộp ảnh Sau khi hoàn thành</SectionTitle>
              <Body>
                Sau khi dọn dẹp xong hiện trường, chụp hoặc chọn ảnh kết quả rõ nét để Ban quản lý phê duyệt, đóng sự cố và cấp chứng nhận.
              </Body>
              {pendingAfterImage && (
                <Photo uri={pendingAfterImage.uri} label="Ảnh Sau vừa chọn (chưa gửi)" />
              )}
              <View style={styles.gridTwo}>
                <View style={styles.flexOne}>
                  <Button
                    title="📷 Chụp ảnh Sau"
                    secondary
                    compact
                    disabled={busy}
                    onPress={() => void runAction(() => pickAfterPhoto(true))}
                  />
                </View>
                <View style={styles.flexOne}>
                  <Button
                    title="🖼️ Chọn từ thư viện"
                    secondary
                    compact
                    disabled={busy}
                    onPress={() => void runAction(() => pickAfterPhoto(false))}
                  />
                </View>
              </View>
              {pendingAfterImage && (
                <Button
                  title={busy ? 'Đang tải ảnh lên…' : '✨ Gửi ảnh Sau để Ban quản lý duyệt'}
                  tone="success"
                  disabled={busy}
                  onPress={() => void uploadAfterPhoto()}
                />
              )}
            </Card>
          )}

          <Card>
            <SectionTitle>Danh sách sinh viên tham gia ({activeParticipants.length})</SectionTitle>
            {activeParticipants.length === 0 ? (
              <Text style={styles.caption}>Chưa có thành viên nào đăng ký.</Text>
            ) : (
              <View style={s.participantList}>
                {activeParticipants.map((p) => (
                  <View key={p.id} style={s.participantRow}>
                    <View style={s.participantInfo}>
                      <Text style={s.participantName}>{p.displayName}</Text>
                      <Text style={styles.caption}>Đăng ký: {dateLabel(p.joinedAt)}</Text>
                    </View>
                    <View style={s.participantRight}>
                      <Badge
                        tone={p.status === 'certified' ? 'success' : 'primary'}
                        label={participantStatusLabels[p.status]}
                      />
                      {!!p.certificateCode && (
                        <Text style={s.certCode}>{p.certificateCode}</Text>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </Card>
        </>
      )}

      <View style={styles.gridTwo}>
        <View style={styles.flexOne}>
          <Button
            title="🔄 Tải lại"
            secondary
            disabled={loading || busy}
            onPress={() => {
              setLoading(true);
              setError('');
              setRetry(value => value + 1);
            }}
          />
        </View>
        <View style={styles.flexOne}>
          <Button title="← Danh sách buổi" onPress={onBackToList} />
        </View>
      </View>
    </Page>
  );
}

const s = StyleSheet.create({
  headerBox: { gap: 2 },
  title: { fontSize: 18, fontWeight: '800', color: colors.ink },
  metaList: { gap: 4 },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.success },
  incidentBox: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 8,
  },
  noticeCard: {
    backgroundColor: colors.successSoft,
    borderColor: colors.successBorder,
    borderWidth: 1.5,
  },
  noticeText: { color: colors.success, fontSize: 14, fontWeight: '700' },
  verifiedCard: {
    backgroundColor: colors.successSoft,
    borderColor: colors.successBorder,
    borderWidth: 1.5,
  },
  rejectCard: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warningBorder,
    borderWidth: 1.5,
  },
  participantList: { gap: 8 },
  participantRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  participantInfo: { flex: 1, gap: 2 },
  participantName: { fontSize: 14, fontWeight: '700', color: colors.ink },
  participantRight: { alignItems: 'flex-end', gap: 4 },
  certCode: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.success,
    backgroundColor: colors.successSoft,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
});
