import {readFileSync,writeFileSync} from 'node:fs';
const pins = {
  "test/ceo-hold-posture-review.test.ts": "dd13e49bfd9f47e2f51b1ff1ef8c4c3d052b159f4ebf6a91d0c4f2efe8beb436",
  "test/helpers/autoplan-artifact-recorder.ts": "b09680f7cc6b68cd4f0c956b0c063031a918e0b0ecca56cdcf7fcf9d3cd05be5",
  "test/helpers/plan-review-board-feedback.ts": "9b6ca7e55339f3b5c96b9abf2b27b3008ac4c5a79dbc613e89376b8b7c267173",
  "test/helpers/touchfiles-data.ts": "ec46a41f9ec62624ea48116ff0550e981f2a2269dff4cbaca636e8fd1fe623bc",
  "test/periodic-fixture-selection.test.ts": "2569339a05f2c593090028470828f0dec0bb4cb2fb29bb595119bf59a9ea722c",
  "test/plan-review-board-feedback.test.ts": "ce6f9f0fcef3c13e57025878af21a7ae7872c42dfdbf4f3fe2104b39ff503ffa",
  "test/autoplan-artifact-windows-argv.test.ts": "b243643a05fd6be8f8722fdc5f761b509854a659239aca656183efd2ef979e86"
};
for (const [file, expected] of Object.entries(pins)) {
 const actual = new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex');
 if (actual !== expected) throw new Error('Mirrored input changed: ' + file);
}
writeFileSync('windows-focused-pins.json', JSON.stringify({bun: Bun.version, pins},null,2));
console.log('Mirrored source hashes match for ' + Object.keys(pins).length + ' repair files');
