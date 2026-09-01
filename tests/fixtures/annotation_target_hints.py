from sample.models import Item, ProcessReport, ProcessRequest
from sample.ports import ServiceUnavailable, InvalidInput
from sample.service import ProcessingService


class ProcessingTest:
    def test_invalid_request(self):
        store = RecordingStore()
        repository = RecordingRepository()
        service = ProcessingService(store, repository)

        with self.assertRaises(ValueError):
            service.process(self.request)

        self.assertEqual(store.items, [])
