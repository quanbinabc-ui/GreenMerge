import { router } from 'expo-router';
import { HomeScreen } from '../screens/HomeScreen';
export default function Home() {
  return (
    <HomeScreen
      onReport={() => router.push('/report')}
      onResumePending={() => router.push('/result')}
      onDetail={id => router.push({ pathname: '/detail', params: { id } })}
    />
  );
}
