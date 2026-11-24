import { router } from 'expo-router';
import { ResultScreen } from '../screens/ResultScreen';
import { clearPendingDraft } from '../services/pending-draft';
import { useFlow } from '../state/flow';
import { Body, Button, Page } from '../ui';
export default function Result() {
  const { result, capturedImageUri, setResult, setCapturedImageUri, setBusy } = useFlow();
  if (!result) return <Page><Body>Không có báo cáo đang chờ. Hãy gửi ảnh mới.</Body><Button title="Báo cáo sự cố" onPress={() => router.replace('/report')} /></Page>;
  const clearFlow = () => {
    clearPendingDraft();
    setResult(null);
    setCapturedImageUri(null);
  };
  return (
    <ResultScreen
      result={result}
      capturedImageUri={capturedImageUri}
      onBusy={setBusy}
      onConfirmed={id => {
        clearFlow();
        router.replace({ pathname: '/detail', params: { id } });
      }}
      onHome={() => {
        clearFlow();
        router.dismissTo('/');
      }}
      onNewReport={() => {
        clearFlow();
        router.replace('/report');
      }}
    />
  );
}
