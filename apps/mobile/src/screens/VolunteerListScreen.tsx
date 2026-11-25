import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { VolunteerEvent, VolunteerEventStatus, VolunteerStats } from '@civicmerge/contracts';
import { api, imageSourceUrl } from '../services/api';
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
  Photo,
  SectionTitle,
  styles,
  VolunteerStatusBadge,
} from '../ui';

const STATUS_FILTERS: { value: VolunteerEventStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Tất cả' },
  { value: 'recruiting', label: 'Đang tuyển' },
  { value: 'in_progress', label: 'Đang thực hiện' },
  { value: 'pending_review', label: 'Chờ duyệt' },
  { value: 'verified', label: 'Đã hoàn thành' },
];

export function VolunteerListScreen({
  onSelectEvent,
  onCertificates,
}: {
  onSelectEvent(id: string): void;
  onCertificates(): void;
}) {
  const [events, setEvents] = useState<VolunteerEvent[]>([]);
  const [stats, setStats] = useState<VolunteerStats | null>(null);
  const [statusFilter, setStatusFilter] = useState<VolunteerEventStatus | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (options: { isRefresh?: boolean; nextStatus?: VolunteerEventStatus | 'all' } = {}) => {
      const activeStatus = options.nextStatus ?? statusFilter;
      if (options.isRefresh) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        const res = await api.listVolunteerEvents({
          ...(activeStatus !== 'all' ? { status: activeStatus } : {}),
          limit: 50,
          offset: 0,
        });
        setEvents(res.events);
        if (res.stats) setStats(res.stats);
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [statusFilter],
  );

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const header = (
    <View style={s.headerSection}>
      <Card style={s.heroCard}>
        <View style={styles.rowBetween}>
          <View style={s.flexText}>
            <Heading>🌿 Buổi Tình Nguyện Xanh</Heading>
            <Text style={styles.caption}>
              Tầng 2 Cộng đồng · Cùng sinh viên dọn dẹp &amp; nhận Giấy chứng nhận
            </Text>
          </View>
          <Button title="🏅 Chứng nhận" secondary compact onPress={onCertificates} />
        </View>
        {stats && (
          <View style={styles.rowWrap}>
            <Badge tone="success" label={`✓ ${stats.verifiedEvents} buổi đã duyệt`} />
            <Badge tone="primary" label={`🏅 ${stats.totalCertificates} chứng nhận đã cấp`} />
          </View>
        )}
      </Card>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRail}>
        {STATUS_FILTERS.map((item) => {
          const active = statusFilter === item.value;
          return (
            <Pressable
              key={item.value}
              accessibilityRole="button"
              onPress={() => {
                setStatusFilter(item.value);
                void load({ nextStatus: item.value });
              }}
              style={[s.filterChip, active && s.filterChipActive]}
            >
              <Text style={[s.filterChipText, active && s.filterChipTextActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {loading && <Loading label="Đang tải danh sách Buổi Tình Nguyện Xanh…" />}
      {!!error && <ErrorNotice message={error} />}
    </View>
  );

  return (
    <FlatList
      data={events}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.page}
      ListHeaderComponent={header}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void load({ isRefresh: true })}
          tintColor={colors.success}
          colors={[colors.success]}
        />
      }
      ListEmptyComponent={
        !loading && !error ? (
          <Card style={s.emptyCard}>
            <SectionTitle>Chưa có Buổi Tình Nguyện Xanh nào</SectionTitle>
            <Body>
              Mở một hồ sơ sự cố Rác thải hoặc Ngập nước mức Thấp ở Trang chủ để khởi tạo buổi dọn dẹp cộng đồng đầu tiên!
            </Body>
          </Card>
        ) : undefined
      }
      renderItem={({ item: ev }) => {
        const progressRatio = Math.min(1, ev.maxParticipants > 0 ? ev.participantCount / ev.maxParticipants : 0);
        return (
          <Card>
            <View style={styles.rowBetween}>
              <VolunteerStatusBadge status={ev.status} />
              <Badge
                tone={ev.participantCount >= ev.maxParticipants ? 'warning' : 'success'}
                label={`👥 ${ev.participantCount}/${ev.maxParticipants} TNV`}
              />
            </View>

            <Text style={s.eventTitle}>{ev.title}</Text>
            {!!ev.description && <Body>{ev.description}</Body>}

            {ev.afterImageUrl ? (
              <View style={styles.gridTwo}>
                <View style={styles.flexOne}>
                  <Photo uri={imageSourceUrl(ev.beforeImageUrl)} label="Ảnh TRƯỚC" compact />
                </View>
                <View style={styles.flexOne}>
                  <Photo uri={imageSourceUrl(ev.afterImageUrl)} label="Ảnh SAU" compact />
                </View>
              </View>
            ) : (
              <Photo
                uri={imageSourceUrl(ev.beforeImageUrl)}
                label={`Ảnh trước xử lý · Trưởng nhóm: ${ev.organizerName}`}
              />
            )}

            <View style={s.progressTrack}>
              <View style={[s.progressFill, { width: `${Math.round(progressRatio * 100)}%` }]} />
            </View>

            <Text style={styles.caption}>📍 {ev.meetingPoint}</Text>
            <Text style={styles.caption}>🕒 {dateLabel(ev.scheduledAt)}</Text>

            <Button
              title={ev.status === 'verified' ? 'Xem kết quả Trước–Sau →' : 'Xem chi tiết & Tham gia →'}
              tone={ev.status === 'verified' ? 'primary' : 'success'}
              compact
              onPress={() => onSelectEvent(ev.id)}
            />
          </Card>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  headerSection: {
    gap: 12,
  },
  heroCard: {
    backgroundColor: colors.successSoft,
    borderColor: colors.successBorder,
    borderWidth: 1.5,
  },
  flexText: {
    flex: 1,
    gap: 2,
  },
  chipRail: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 2,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterChipActive: {
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
  },
  filterChipTextActive: {
    color: colors.success,
    fontWeight: '700',
  },
  eventTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.ink,
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.success,
  },
  emptyCard: {
    alignItems: 'center',
    paddingVertical: 28,
  },
});
