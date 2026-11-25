import { router } from 'expo-router';
import { CertificatesScreen } from '../screens/CertificatesScreen';

export default function CertificatesRoute() {
  return (
    <CertificatesScreen
      onOpenEvent={eventId => router.push({ pathname: '/volunteer-detail', params: { id: eventId } })}
    />
  );
}
