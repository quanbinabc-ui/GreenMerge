import { useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  isIncidentSafeForVolunteer,
  type HistoryEvent,
  type IncidentDetail,
  type VolunteerEvent,
} from '@civicmerge/contracts';
import { api, imageSourceUrl } from '../services/api';
import { mapUrlForLocation } from '../services/pending-draft-format';
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
  Photo,
  SectionTitle,
  SeverityBadge,
  StatusBadge,
  StatusStepper,
  statusLabels,
  styles,
  TypeBadge,
  VolunteerStatusBadge,
} from '../ui';

function historyTitle(event: HistoryEvent): string {
  if (event.event === 'created') return 'Khởi tạo hồ sơ sự cố mới';
  if (event.event === 'report_merged') return 'Hợp nhất thêm minh chứng từ cộng đồng';
  if (event.event === 'volunteer_event_created') return '🌿 Khởi tạo Buổi Tình Nguyện Xanh';
  if (event.event === 'volunteer_after_submitted') return '📸 Đã nộp ảnh Sau khi hoàn thành';
  if (event.event === 'volunteer_verified') return '🏅 Đã duyệt Tình Nguyện Xanh & Đóng hồ sơ';
  if (event.event === 'status_changed') {
    const from = event.fromStatus ? statusLabels[event.fromStatus] : '';
    const to = event.toStatus ? statusLabels[event.toStatus] : '';
    return from && to ? `Chuyển trạng thái: ${from} → ${to}` : 'Cập nhật trạng thái hồ sơ';
  }
  return 'Cập nhật đơn vị xử lý';
}

export function DetailScreen({
  id,
  onHome,
  onVolunteerDetail,
}: {
  id: string;
  onHome(): void;
  onVolunteerDetail(eventId: string): void;
}) {
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [linkedEvent, setLinkedEvent] = useState<VolunteerEvent | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [eventTitle, setEventTitle] = useState('');
  const [meetingPoint, setMeetingPoint] = useState('');
  const [maxParticipantsInput, setMaxParticipantsInput] = useState('10');
  const [organizerName, setOrganizerName] = useState('');
  const [eventDescription, setEventDescription] = useState('');
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [volunteerError, setVolunteerError] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([
      api.detail(id),
      api.listVolunteerEvents({ incidentId: id, limit: 5 }).catch(() => ({ events: [] as VolunteerEvent[] })),
    ])
      .then(([value, volunteerRes]) => {
        if (!active) return;
        setDetail(value);
        const existing = volunteerRes.events.find(ev => ev.status !== 'cancelled') ?? null;
        setLinkedEvent(existing);
        setEventTitle(prev => prev || `Dọn dẹp xanh: ${value.description.slice(0, 60)}`);
        setMeetingPoint(prev => prev || value.address || 'Điểm tập trung tại khu vực sự cố');
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

  async function handleCreateVolunteerEvent() {
    if (!detail) return;
    const maxNum = Number(maxParticipantsInput.trim());
    if (!Number.isInteger(maxNum) || maxNum < 2 || maxNum > 50) {
      setVolunteerError('Số lượng sinh viên tối đa phải từ 2 đến 50 người.');
      return;
    }
    setCreatingEvent(true);
    setVolunteerError('');
    try {
      const scheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const created = await api.createVolunteerEvent(detail.id, {
        title: eventTitle.trim(),
        description: eventDescription.trim(),
        scheduledAt,
        meetingPoint: meetingPoint.trim(),
        maxParticipants: maxNum,
        ...(organizerName.trim() ? { organizerName: organizerName.trim() } : {}),
      });
      setLinkedEvent(created);
      setShowCreateForm(false);
      onVolunteerDetail(created.id);
    } catch (err) {
      setVolunteerError(messageOf(err));
    } finally {
      setCreatingEvent(false);
    }
  }

  return (
    <Page>
      <View style={s.headerBox}>
        <Heading>Hồ sơ sự cố thống nhất</Heading>
        <Text style={styles.caption}>Mã hồ sơ: #{id.slice(0, 8).toUpperCase()}</Text>
      </View>

      {loading && <Loading label="Đang tải thông tin hồ sơ…" />}
      {!!error && <ErrorNotice message={error} />}

      {detail && (
        <>
          <StatusStepper status={detail.status} />

          {detail.reportCount > 1 && (
            <Card style={s.mergedBanner}>
              <Badge tone="success" label="✓ ĐÃ HỢP NHẤT PHẢN ÁNH" />
              <Body>
                Hồ sơ này đã gom {detail.reportCount} lượt báo cáo từ người dân vào một đầu mối xử lý duy nhất.
              </Body>
            </Card>
          )}

          <Card>
            <View style={styles.rowBetween}>
              <View style={styles.rowWrap}>
                <TypeBadge type={detail.type} />
                <SeverityBadge severity={detail.severity} />
              </View>
              <StatusBadge status={detail.status} />
            </View>

            <Body>{detail.description}</Body>

            <View style={s.infoGrid}>
              <View style={s.infoItem}>
                <Text style={styles.caption}>Đơn vị tiếp nhận xử lý</Text>
                <Text style={s.infoValue}>🏛️ {detail.assignedTeam}</Text>
              </View>
              <View style={s.infoItem}>
                <Text style={styles.caption}>Tổng số minh chứng</Text>
                <Text style={s.infoValue}>📸 {detail.reportCount} hình ảnh</Text>
              </View>
            </View>

            {detail.address && (
              <Text style={s.addressValue}>{detail.address}</Text>
            )}

            {detail.location ? (
              <View style={s.locationBox}>
                <Text style={styles.caption}>
                  Tọa độ GPS: {detail.location.latitude.toFixed(6)},{' '}
                  {detail.location.longitude.toFixed(6)}
                </Text>
                <Button
                  title="Mở vị trí trên Bản đồ"
                  secondary
                  compact
                  onPress={() => {
                    const url = mapUrlForLocation(detail.location!, Platform.OS);
                    void Linking.openURL(url).catch(() => setError('Không mở được ứng dụng bản đồ trên thiết bị.'));
                  }}
                />
              </View>
            ) : (
              <Text style={styles.caption}>Hồ sơ chưa có tọa độ GPS.</Text>
            )}

            {detail.status === 'resolved' && (detail.resolutionNote || detail.resolvedAt || detail.resolutionImageUrl) && (
              <View style={s.resolutionBox}>
                <Badge tone="success" label="✓ THÔNG TIN XỬ LÝ" />
                {detail.resolvedAt && (
                  <Text style={styles.caption}>Hoàn thành lúc: {dateLabel(detail.resolvedAt)}</Text>
                )}
                {detail.resolutionNote && <Body>{detail.resolutionNote}</Body>}
                {detail.resolutionImageUrl && (
                  <Photo
                    uri={imageSourceUrl(detail.resolutionImageUrl)}
                    label="Ảnh nghiệm thu sau khi xử lý"
                  />
                )}
              </View>
            )}

            {detail.features.length > 0 && (
              <View style={styles.rowWrap}>
                {detail.features.map((feature) => (
                  <Badge key={feature} tone="neutral" label={feature} />
                ))}
              </View>
            )}
          </Card>

          {(isIncidentSafeForVolunteer(detail) || linkedEvent) && (
            <Card style={s.volunteerCard}>
              <View style={styles.rowBetween}>
                <SectionTitle>🌿 Kết Nối Buổi Tình Nguyện Xanh</SectionTitle>
                {linkedEvent ? (
                  <VolunteerStatusBadge status={linkedEvent.status} />
                ) : (
                  <Badge tone="success" label="An toàn Tầng 2" />
                )}
              </View>
              {linkedEvent ? (
                <>
                  <Text style={s.volunteerTitle}>{linkedEvent.title}</Text>
                  <Text style={styles.caption}>
                    📍 {linkedEvent.meetingPoint} · 👥 {linkedEvent.participantCount}/{linkedEvent.maxParticipants} TNV
                  </Text>
                  <Text style={styles.caption}>🕒 Dự kiến: {dateLabel(linkedEvent.scheduledAt)}</Text>
                  <Button
                    title="Mở Buổi Tình Nguyện để tham gia →"
                    tone="success"
                    onPress={() => onVolunteerDetail(linkedEvent.id)}
                  />
                </>
              ) : (
                <>
                  <Body>
                    Sự cố này đủ điều kiện an toàn để cộng đồng sinh viên cùng dọn dẹp, chụp ảnh Sau và nhận Giấy chứng nhận Tình nguyện Xanh.
                  </Body>
                  {!!volunteerError && <ErrorNotice message={volunteerError} />}
                  {showCreateForm ? (
                    <View style={s.volunteerForm}>
                      <TextInput
                        accessibilityLabel="Tiêu đề buổi tình nguyện"
                        placeholder="Tiêu đề buổi tình nguyện"
                        value={eventTitle}
                        onChangeText={setEventTitle}
                        editable={!creatingEvent}
                        style={styles.input}
                      />
                      <TextInput
                        accessibilityLabel="Điểm tập trung"
                        placeholder="Điểm tập trung (ví dụ: Cổng B ký túc xá)"
                        value={meetingPoint}
                        onChangeText={setMeetingPoint}
                        editable={!creatingEvent}
                        style={styles.input}
                      />
                      <TextInput
                        accessibilityLabel="Số tình nguyện viên tối đa"
                        placeholder="Số người tối đa (2–50)"
                        value={maxParticipantsInput}
                        onChangeText={setMaxParticipantsInput}
                        keyboardType="number-pad"
                        editable={!creatingEvent}
                        style={styles.input}
                      />
                      <TextInput
                        accessibilityLabel="Tên trưởng nhóm"
                        placeholder="Tên trưởng nhóm (tùy chọn)"
                        value={organizerName}
                        onChangeText={setOrganizerName}
                        editable={!creatingEvent}
                        style={styles.input}
                      />
                      <TextInput
                        accessibilityLabel="Mô tả dụng cụ hoặc lưu ý"
                        placeholder="Ghi chú dụng cụ: găng tay, bao rác... (tùy chọn)"
                        value={eventDescription}
                        onChangeText={setEventDescription}
                        editable={!creatingEvent}
                        multiline
                        style={styles.input}
                      />
                      <View style={styles.gridTwo}>
                        <View style={styles.flexOne}>
                          <Button
                            title="Hủy"
                            secondary
                            compact
                            disabled={creatingEvent}
                            onPress={() => setShowCreateForm(false)}
                          />
                        </View>
                        <View style={styles.flexOne}>
                          <Button
                            title={creatingEvent ? 'Đang khởi tạo…' : 'Khởi tạo buổi'}
                            tone="success"
                            compact
                            disabled={creatingEvent || eventTitle.trim().length < 3 || meetingPoint.trim().length < 2}
                            onPress={() => void handleCreateVolunteerEvent()}
                          />
                        </View>
                      </View>
                    </View>
                  ) : (
                    <Button
                      title="🌿 Khởi tạo Buổi Tình Nguyện Xanh"
                      tone="success"
                      onPress={() => setShowCreateForm(true)}
                    />
                  )}
                </>
              )}
            </Card>
          )}

          <View style={styles.rowBetween}>
            <SectionTitle>Hình ảnh minh chứng ({detail.reports.length})</SectionTitle>
            <Badge tone="primary" label={`${detail.reports.length} lượt gửi`} />
          </View>

          {detail.reports.map((report, index) => (
            <Card key={report.id}>
              <View style={styles.rowBetween}>
                <Badge
                  tone={index === 0 ? 'primary' : 'success'}
                  label={
                    index === 0
                      ? 'Minh chứng #1 (Báo cáo gốc)'
                      : `Minh chứng #${index + 1} (Đã hợp nhất)`
                  }
                />
                <Text style={styles.caption}>{dateLabel(report.createdAt)}</Text>
              </View>
              <Photo
                uri={imageSourceUrl(report.imageUrl)}
                label={`Minh chứng ${index + 1} · ${report.analysis.description}`}
              />
              {report.userNote && (
                <Text style={styles.caption}>📝 Ghi chú người gửi: {report.userNote}</Text>
              )}
            </Card>
          ))}

          <Card>
            <SectionTitle>Lịch sử xử lý hồ sơ</SectionTitle>
            <View style={s.timeline}>
              {detail.history.map((event, index) => {
                const dotColor = event.event === 'created'
                  ? colors.primary
                  : event.event === 'status_changed'
                    ? colors.warning
                    : colors.success;
                return (
                  <View key={index} style={s.timelineItem}>
                    <View
                      style={[
                        s.timelineDot,
                        { backgroundColor: dotColor },
                      ]}
                    />
                    <View style={s.timelineContent}>
                      <Text style={s.timelineTitle}>{historyTitle(event)}</Text>
                      {event.actor && <Text style={styles.caption}>Thực hiện: {event.actor}</Text>}
                      {event.note && <Text style={styles.caption}>Ghi chú: {event.note}</Text>}
                      <Text style={styles.caption}>{dateLabel(event.at)}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          </Card>
        </>
      )}

      <View style={styles.gridTwo}>
        <View style={styles.flexOne}>
          <Button
            title="🔄 Tải lại hồ sơ"
            secondary
            disabled={loading}
            onPress={() => {
              setLoading(true);
              setError('');
              setRetry((value) => value + 1);
            }}
          />
        </View>
        <View style={styles.flexOne}>
          <Button title="← Về trang chủ" onPress={onHome} />
        </View>
      </View>
    </Page>
  );
}

const s = StyleSheet.create({
  headerBox: {
    gap: 2,
  },
  mergedBanner: {
    backgroundColor: colors.successSoft,
    borderColor: colors.successBorder,
    borderWidth: 1.5,
  },
  infoGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  infoItem: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  infoValue: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
  },
  timeline: {
    gap: 12,
    paddingTop: 4,
  },
  timelineItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  timelineDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginTop: 5,
  },
  timelineContent: {
    flex: 1,
    gap: 2,
  },
  timelineTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.ink,
  },
  locationBox: {
    gap: 8,
  },
  addressValue: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.primaryDark,
  },
  resolutionBox: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.successSoft,
    borderWidth: 1,
    borderColor: colors.successBorder,
    gap: 6,
  },
  volunteerCard: {
    backgroundColor: colors.successSoft,
    borderColor: colors.successBorder,
    borderWidth: 1.5,
  },
  volunteerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.ink,
  },
  volunteerForm: {
    gap: 10,
  },
});
