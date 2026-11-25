import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Alert, FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { IncidentStatus, IncidentSummary, IncidentType } from '@civicmerge/contracts';
import {
  api,
  API_URL,
  AUTH_TOKEN,
  imageSourceUrl,
  providerState,
  setApiUrl,
  setAuthToken,
} from '../services/api';
import { clearPendingDraft, readPendingDraft, type PendingDraft } from '../services/pending-draft';
import { useFlow } from '../state/flow';
import {
  Badge,
  Body,
  Button,
  Card,
  colors,
  dateLabel,
  ErrorNotice,
  Loading,
  messageOf,
  Photo,
  SectionTitle,
  SeverityBadge,
  StatusBadge,
  styles,
  TypeBadge,
  typeLabels,
} from '../ui';

const PAGE_SIZE = 20;

const TYPE_FILTERS: { value: IncidentType | 'all'; label: string }[] = [
  { value: 'all', label: 'Tất cả' },
  { value: 'pothole', label: 'Ổ gà' },
  { value: 'trash', label: 'Rác thải' },
  { value: 'flood', label: 'Ngập nước' },
];

const STATUS_FILTERS: { value: IncidentStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Mọi trạng thái' },
  { value: 'open', label: 'Mới tiếp nhận' },
  { value: 'in_progress', label: 'Đang xử lý' },
  { value: 'resolved', label: 'Đã xử lý' },
];

export function HomeScreen({
  onReport,
  onDetail,
  onResumePending,
  onVolunteers,
  onCertificates,
}: {
  onReport(): void;
  onDetail(id: string): void;
  onResumePending(): void;
  onVolunteers(): void;
  onCertificates(): void;
}) {
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [backendUrl, setBackendUrl] = useState(API_URL);
  const [tokenInput, setTokenInput] = useState(AUTH_TOKEN);
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [isSignupMode, setIsSignupMode] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'account' | 'server'>(API_URL ? 'account' : 'server');
  const [accountLabel, setAccountLabel] = useState('');
  const [connectionNote, setConnectionNote] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(!API_URL);
  const [typeFilter, setTypeFilter] = useState<IncidentType | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<IncidentStatus | 'all'>('all');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const { setResult, setCapturedImageUri } = useFlow();

  const buildFilter = useCallback(
    (
      nextType: IncidentType | 'all',
      nextStatus: IncidentStatus | 'all',
      nextQuery: string,
      nextMine: boolean,
      offset: number,
    ) => ({
      ...(nextType !== 'all' ? { type: nextType } : {}),
      ...(nextStatus !== 'all' ? { status: nextStatus } : {}),
      ...(nextQuery.trim() ? { q: nextQuery.trim() } : {}),
      ...(nextMine && AUTH_TOKEN ? { mine: true } : {}),
      limit: PAGE_SIZE,
      offset,
    }),
    [],
  );

  const checkPendingDraft = useCallback(async () => {
    const draft = readPendingDraft(API_URL);
    if (!draft) {
      setPendingDraft(null);
      return;
    }
    try {
      const report = await api.report(draft.result.reportId);
      if (report.status === 'pending') {
        setPendingDraft(draft);
      } else {
        clearPendingDraft();
        setPendingDraft(null);
      }
    } catch {
      clearPendingDraft();
      setPendingDraft(null);
    }
  }, []);

  const load = useCallback(
    async (
      options: {
        isRefresh?: boolean;
        append?: boolean;
        nextType?: IncidentType | 'all';
        nextStatus?: IncidentStatus | 'all';
        nextQuery?: string;
        nextMine?: boolean;
      } = {},
    ) => {
      const activeType = options.nextType ?? typeFilter;
      const activeStatus = options.nextStatus ?? statusFilter;
      const activeQuery = options.nextQuery ?? searchQuery;
      const activeMine = options.nextMine ?? mineOnly;
      const offset = options.append ? incidents.length : 0;

      if (options.append) setLoadingMore(true);
      else if (options.isRefresh) setRefreshing(true);
      else setLoading(true);
      setError('');

      if (!API_URL) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
        setSettingsTab('server');
        setSettingsOpen(true);
        return;
      }
      try {
        if (!options.append) await api.health();
        const response = await api.list(buildFilter(activeType, activeStatus, activeQuery, activeMine, offset));
        setIncidents((prev) => {
          if (!options.append) return response.incidents;
          const seen = new Set(prev.map((item) => item.id));
          return [...prev, ...response.incidents.filter((item) => !seen.has(item.id))];
        });
        setTotalCount(response.total ?? (options.append ? incidents.length + response.incidents.length : response.incidents.length));
        if (!options.append) await checkPendingDraft();
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [buildFilter, checkPendingDraft, incidents.length, mineOnly, searchQuery, statusFilter, typeFilter],
  );

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  async function submitAccountAuth() {
    setLoading(true);
    setError('');
    setConnectionNote('');
    try {
      const session = isSignupMode
        ? await api.signup({
          email: emailInput.trim(),
          password: passwordInput,
          ...(displayNameInput.trim() ? { displayName: displayNameInput.trim() } : {}),
        })
        : await api.login({ email: emailInput.trim(), password: passwordInput });
      setAuthToken(session.accessToken);
      setTokenInput(session.accessToken);
      setAccountLabel(session.user.displayName || emailInput.trim());
      setPasswordInput('');
      setConnectionNote(`Đã đăng nhập thành công (${session.user.displayName || session.user.role}).`);
      await load();
      setSettingsOpen(false);
    } catch (err) {
      setError(messageOf(err));
      setLoading(false);
    }
  }

  async function connectServer() {
    setLoading(true);
    setError('');
    setConnectionNote('');
    try {
      setApiUrl(backendUrl);
      setBackendUrl(API_URL);
      setAuthToken(tokenInput);
      setTokenInput(AUTH_TOKEN);
      if (!AUTH_TOKEN) {
        setMineOnly(false);
        setAccountLabel('');
      }
      setResult(null);
      setCapturedImageUri(null);
      setIncidents([]);
      const health = await api.health();
      const response = await api.list(buildFilter(typeFilter, statusFilter, searchQuery, Boolean(AUTH_TOKEN && mineOnly), 0));
      setIncidents(response.incidents);
      setTotalCount(response.total ?? response.incidents.length);
      await checkPendingDraft();
      setConnectionNote(
        health.capabilities?.persistence === 'postgres' && health.capabilities.storage === 'supabase'
          ? 'Đã kết nối PostgreSQL và Supabase Storage.'
          : 'Đã kết nối máy chủ.',
      );
      setSettingsOpen(false);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setAuthToken('');
    setTokenInput('');
    setAccountLabel('');
    setMineOnly(false);
    setConnectionNote('Đã đăng xuất phiên hiện tại.');
    void load({ nextMine: false });
  }

  function reset() {
    Alert.alert(
      'Reset dữ liệu mock?',
      'Xóa dữ liệu nghiệp vụ của backend đang kết nối. Chỉ reset khi cả nhóm đã thống nhất.',
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            setLoading(true);
            setError('');
            clearPendingDraft();
            setPendingDraft(null);
            void api
              .reset()
              .then(() => load())
              .catch((err) => {
                setError(messageOf(err));
                setLoading(false);
              });
          },
        },
      ],
    );
  }

  function resumeDraft() {
    if (!pendingDraft) return;
    setResult(pendingDraft.result);
    setCapturedImageUri(pendingDraft.capturedImageUri);
    onResumePending();
  }

  function discardDraft() {
    clearPendingDraft();
    setPendingDraft(null);
  }

  const hasMore = incidents.length < totalCount;
  const totalReports = incidents.reduce((sum, item) => sum + item.reportCount, 0);

  const listHeader = (
    <View style={s.headerSection}>
      {/* Compact Hero Bar — leaves first incident card visible above the fold */}
      <Card style={s.heroCard}>
        <View style={styles.rowBetween}>
          <View style={s.heroStatsInline}>
            <Text style={s.heroTitle}>Phản ánh đô thị</Text>
            <Text style={styles.caption}>
              {totalCount} hồ sơ · {totalReports} minh chứng
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Tài khoản và Cài đặt máy chủ"
            onPress={() => setSettingsOpen(true)}
            style={({ pressed }) => [s.settingsButton, { opacity: pressed ? 0.72 : 1 }]}
          >
            <Text style={s.settingsButtonText}>
              {AUTH_TOKEN ? `● ${accountLabel || 'Đã đăng nhập'}` : '⚙ Cài đặt'}
            </Text>
          </Pressable>
        </View>
        <Button title="+ Báo cáo sự cố mới" onPress={onReport} disabled={loading || !API_URL} />
        <View style={styles.gridTwo}>
          <View style={styles.flexOne}>
            <Button title="🌿 Tình nguyện Xanh" secondary compact onPress={onVolunteers} disabled={!API_URL} />
          </View>
          <View style={styles.flexOne}>
            <Button title="🏅 Chứng nhận" secondary compact onPress={onCertificates} disabled={!API_URL} />
          </View>
        </View>
        {!API_URL && (
          <Text style={styles.caption}>Chưa cấu hình máy chủ — bấm ⚙ Cài đặt để kết nối.</Text>
        )}
      </Card>

      {pendingDraft && (
        <Card style={s.draftCard}>
          <View style={styles.rowBetween}>
            <Badge tone="warning" label="BÁO CÁO ĐANG CHỜ XÁC NHẬN" />
            <Pressable onPress={discardDraft}>
              <Text style={s.dismissLink}>Bỏ qua</Text>
            </Pressable>
          </View>
          <Body>Bạn có một báo cáo đã phân tích xong nhưng chưa xác nhận.</Body>
          <Button title="Tiếp tục xác nhận →" onPress={resumeDraft} compact />
        </Card>
      )}

      {/* Compact Search + Single-row Horizontal Filter Strip */}
      <View style={s.filterSection}>
        <View style={s.searchRow}>
          <TextInput
            accessibilityLabel="Tìm kiếm sự cố"
            placeholder="Tìm theo mô tả, địa chỉ, tổ xử lý…"
            value={searchInput}
            onChangeText={setSearchInput}
            returnKeyType="search"
            onSubmitEditing={() => {
              const trimmed = searchInput.trim();
              setSearchQuery(trimmed);
              void load({ nextQuery: trimmed });
            }}
            style={[styles.input, s.searchInput]}
          />
          <Button
            title="Tìm"
            compact
            secondary
            disabled={loading}
            onPress={() => {
              const trimmed = searchInput.trim();
              setSearchQuery(trimmed);
              void load({ nextQuery: trimmed });
            }}
          />
          {!!searchQuery && (
            <Button
              title="✕"
              compact
              secondary
              disabled={loading}
              onPress={() => {
                setSearchInput('');
                setSearchQuery('');
                void load({ nextQuery: '' });
              }}
            />
          )}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRail}>
          {TYPE_FILTERS.map((item) => {
            const active = typeFilter === item.value;
            return (
              <Pressable
                key={`t-${item.value}`}
                accessibilityRole="button"
                onPress={() => {
                  setTypeFilter(item.value);
                  void load({ nextType: item.value });
                }}
                style={[s.filterChip, active && s.filterChipActive]}
              >
                <Text style={[s.filterChipText, active && s.filterChipTextActive]}>{item.label}</Text>
              </Pressable>
            );
          })}
          <View style={s.chipDivider} />
          {STATUS_FILTERS.map((item) => {
            const active = statusFilter === item.value;
            return (
              <Pressable
                key={`s-${item.value}`}
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
          {!!AUTH_TOKEN && (
            <>
              <View style={s.chipDivider} />
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  const next = !mineOnly;
                  setMineOnly(next);
                  void load({ nextMine: next });
                }}
                style={[s.filterChip, mineOnly && s.filterChipActive]}
              >
                <Text style={[s.filterChipText, mineOnly && s.filterChipTextActive]}>Của tôi</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </View>

      {loading && <Loading label="Đang tải danh sách sự cố…" />}
      {!!error && (
        <View style={s.errorGroup}>
          <ErrorNotice message={error} />
          <View style={styles.gridTwo}>
            <View style={styles.flexOne}>
              <Button title="Thử lại" onPress={() => void load()} secondary compact />
            </View>
            <View style={styles.flexOne}>
              <Button title="Cài đặt máy chủ" onPress={() => { setSettingsTab('server'); setSettingsOpen(true); }} secondary compact />
            </View>
          </View>
        </View>
      )}
    </View>
  );

  return (
    <View style={s.container}>
      <FlatList
        data={incidents}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.page}
        ListHeaderComponent={listHeader}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (hasMore && !loading && !refreshing && !loadingMore) {
            void load({ append: true });
          }
        }}
        ListFooterComponent={
          hasMore ? (
            <View style={s.footerBox}>
              {loadingMore ? (
                <Loading label="Đang tải thêm hồ sơ…" />
              ) : (
                <Button
                  title={`Tải thêm hồ sơ (${incidents.length}/${totalCount})`}
                  secondary
                  compact
                  onPress={() => void load({ append: true })}
                />
              )}
            </View>
          ) : undefined
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load({ isRefresh: true })}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        ListEmptyComponent={
          !loading && !error && !!API_URL ? (
            <Card style={s.emptyCard}>
              <SectionTitle>
                {typeFilter === 'all' && statusFilter === 'all' && !searchQuery && !mineOnly
                  ? 'Chưa có hồ sơ sự cố nào'
                  : 'Không có hồ sơ khớp bộ lọc'}
              </SectionTitle>
              <Body>
                {typeFilter === 'all' && statusFilter === 'all' && !searchQuery && !mineOnly
                  ? 'Bấm "+ Báo cáo sự cố mới" để gửi bức ảnh đầu tiên.'
                  : 'Thử đổi bộ lọc, xóa từ khóa hoặc kéo xuống để tải lại.'}
              </Body>
            </Card>
          ) : undefined
        }
        renderItem={({ item: incident }) => (
          <Card>
            <View style={styles.rowBetween}>
              <View style={styles.rowWrap}>
                <TypeBadge type={incident.type} />
                <SeverityBadge severity={incident.severity} />
              </View>
              <StatusBadge status={incident.status} />
            </View>

            <Photo
              uri={imageSourceUrl(incident.coverImageUrl)}
              label={`${typeLabels[incident.type]} · Cập nhật ${dateLabel(incident.updatedAt)}`}
              overlayLabel={
                incident.reportCount > 1
                  ? `${incident.reportCount} minh chứng · Đã hợp nhất`
                  : '1 minh chứng'
              }
            />

            <Body>{incident.description}</Body>
            {incident.address && (
              <Text style={s.addressLine} numberOfLines={1}>{incident.address}</Text>
            )}

            <View style={styles.rowBetween}>
              <Text style={styles.caption}>{incident.assignedTeam}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => onDetail(incident.id)}
                style={({ pressed }) => [s.detailLinkBtn, { opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={s.detailLinkText}>Xem chi tiết →</Text>
              </Pressable>
            </View>
          </Card>
        )}
      />

      <Modal
        visible={settingsOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setSettingsOpen(false)}
      >
        <View style={s.modalBackdrop}>
          <Card style={s.modalCard}>
            <View style={styles.rowBetween}>
              <SectionTitle>Tài khoản &amp; Kết nối</SectionTitle>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Đóng cài đặt"
                onPress={() => setSettingsOpen(false)}
                style={s.modalClose}
              >
                <Text style={s.modalCloseText}>✕</Text>
              </Pressable>
            </View>

            <View style={s.tabBar}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setSettingsTab('account')}
                style={[s.tabItem, settingsTab === 'account' && s.tabItemActive]}
              >
                <Text style={[s.tabText, settingsTab === 'account' && s.tabTextActive]}>Đăng nhập</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => setSettingsTab('server')}
                style={[s.tabItem, settingsTab === 'server' && s.tabItemActive]}
              >
                <Text style={[s.tabText, settingsTab === 'server' && s.tabTextActive]}>Máy chủ</Text>
              </Pressable>
            </View>

            {settingsTab === 'account' ? (
              <View style={s.modalForm}>
                {AUTH_TOKEN ? (
                  <View style={s.signedInBox}>
                    <Text style={s.signedInTitle}>Đang đăng nhập{accountLabel ? `: ${accountLabel}` : ''}</Text>
                    <Button title="Đăng xuất" onPress={logout} secondary compact disabled={loading} />
                  </View>
                ) : (
                  <>
                    {isSignupMode && (
                      <TextInput
                        accessibilityLabel="Họ tên hiển thị"
                        placeholder="Tên hiển thị (ví dụ: Nguyễn Văn A)"
                        value={displayNameInput}
                        onChangeText={setDisplayNameInput}
                        editable={!loading}
                        style={styles.input}
                      />
                    )}
                    <TextInput
                      accessibilityLabel="Email"
                      placeholder="Email tài khoản"
                      value={emailInput}
                      onChangeText={setEmailInput}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="email-address"
                      editable={!loading}
                      style={styles.input}
                    />
                    <TextInput
                      accessibilityLabel="Mật khẩu"
                      placeholder="Mật khẩu (tối thiểu 6 ký tự)"
                      value={passwordInput}
                      onChangeText={setPasswordInput}
                      secureTextEntry
                      editable={!loading}
                      style={styles.input}
                    />
                    <Button
                      title={isSignupMode ? 'Tạo tài khoản mới' : 'Đăng nhập'}
                      onPress={() => void submitAccountAuth()}
                      disabled={loading || !emailInput.trim() || passwordInput.length < 6 || !API_URL}
                    />
                    <Pressable onPress={() => setIsSignupMode((prev) => !prev)}>
                      <Text style={s.switchAuthText}>
                        {isSignupMode ? 'Đã có tài khoản? Chuyển sang Đăng nhập' : 'Chưa có tài khoản? Đăng ký mới'}
                      </Text>
                    </Pressable>
                  </>
                )}
              </View>
            ) : (
              <View style={s.modalForm}>
                <TextInput
                  accessibilityLabel="Địa chỉ máy chủ"
                  placeholder="http://<LAN-IP>:3000"
                  value={backendUrl}
                  onChangeText={setBackendUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  editable={!loading}
                  style={styles.input}
                />
                <TextInput
                  accessibilityLabel="JWT Bearer Token thủ công (tùy chọn)"
                  placeholder="JWT Token thủ công (tùy chọn)"
                  value={tokenInput}
                  onChangeText={setTokenInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  editable={!loading}
                  style={styles.input}
                />
                <Text style={styles.caption}>{providerState().label}</Text>
                <Button title="Lưu và kết nối" onPress={() => void connectServer()} disabled={loading} />
                {providerState().controlsAllowed && (
                  <Button
                    title="Reset dữ liệu mock"
                    onPress={reset}
                    tone="danger"
                    compact
                    disabled={loading}
                  />
                )}
              </View>
            )}

            {!!connectionNote && (
              <Text accessibilityLiveRegion="polite" style={styles.caption}>{connectionNote}</Text>
            )}
          </Card>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerSection: {
    gap: 12,
  },
  heroCard: {
    backgroundColor: colors.surface,
    borderColor: colors.softBorder,
    borderWidth: 1.5,
    padding: 14,
    gap: 10,
  },
  heroStatsInline: {
    gap: 2,
  },
  heroTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.3,
  },
  settingsButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  settingsButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.ink,
  },
  draftCard: {
    backgroundColor: colors.warningSoft,
    borderColor: colors.warningBorder,
    borderWidth: 1.5,
  },
  dismissLink: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.warning,
  },
  filterSection: {
    gap: 8,
  },
  searchRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  searchInput: {
    flex: 1,
    minHeight: 42,
    paddingVertical: 8,
    fontSize: 14,
  },
  chipRail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 2,
  },
  chipDivider: {
    width: 1,
    height: 18,
    backgroundColor: colors.border,
    marginHorizontal: 2,
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
    borderColor: colors.primary,
    backgroundColor: colors.soft,
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
  },
  filterChipTextActive: {
    color: colors.primaryDark,
    fontWeight: '700',
  },
  errorGroup: {
    gap: 8,
  },
  footerBox: {
    paddingVertical: 8,
  },
  emptyCard: {
    alignItems: 'center',
    paddingVertical: 28,
  },
  addressLine: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.primaryDark,
  },
  detailLinkBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 9,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.softBorder,
  },
  detailLinkText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primaryDark,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  modalClose: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: colors.surfaceMuted,
  },
  modalCloseText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.muted,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    padding: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  tabItem: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: 'center',
  },
  tabItemActive: {
    backgroundColor: colors.surface,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
  },
  tabTextActive: {
    color: colors.primaryDark,
    fontWeight: '700',
  },
  modalForm: {
    gap: 10,
  },
  signedInBox: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.successSoft,
    borderWidth: 1,
    borderColor: colors.successBorder,
    gap: 8,
  },
  signedInTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.success,
  },
  switchAuthText: {
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
    color: colors.primaryDark,
    paddingVertical: 4,
  },
});
