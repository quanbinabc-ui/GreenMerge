import { router, useLocalSearchParams } from 'expo-router';
import { VolunteerDetailScreen } from '../screens/VolunteerDetailScreen';
import { Body, Button, Page } from '../ui';

export default function VolunteerDetailRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (!id || typeof id !== 'string') {
    return (
      <Page>
        <Body>Thiếu mã buổi tình nguyện.</Body>
        <Button title="Danh sách Tình nguyện Xanh" onPress={() => router.replace('/volunteers')} />
      </Page>
    );
  }
  return (
    <VolunteerDetailScreen
      key={id}
      id={id}
      onIncidentDetail={incidentId => router.push({ pathname: '/detail', params: { id: incidentId } })}
      onCertificates={() => router.push('/certificates')}
      onBackToList={() => router.push('/volunteers')}
    />
  );
}
