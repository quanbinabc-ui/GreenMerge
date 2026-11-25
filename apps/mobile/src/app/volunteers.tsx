import { router } from 'expo-router';
import { VolunteerListScreen } from '../screens/VolunteerListScreen';

export default function VolunteersRoute() {
  return (
    <VolunteerListScreen
      onSelectEvent={id => router.push({ pathname: '/volunteer-detail', params: { id } })}
      onCertificates={() => router.push('/certificates')}
    />
  );
}
