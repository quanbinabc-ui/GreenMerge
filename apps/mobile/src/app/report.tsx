import { router } from 'expo-router';
import { ReportScreen } from '../screens/ReportScreen';
import { API_URL } from '../services/api';
import { savePendingDraft } from '../services/pending-draft';
import { useFlow } from '../state/flow';
export default function Report() {
  const { setResult, setCapturedImageUri, setBusy } = useFlow();
  return (
    <ReportScreen
      onBusy={setBusy}
      onResult={(result, capturedImageUri) => {
        savePendingDraft(API_URL, result, capturedImageUri);
        setResult(result);
        setCapturedImageUri(capturedImageUri);
        router.replace('/result');
      }}
    />
  );
}
