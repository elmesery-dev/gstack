import {readFileSync,writeFileSync} from 'node:fs';
const pins = {
  "test/autoplan-artifact-recorder.test.ts": "d8c9e4484d72fb10ec9ff0037ca78d1b56c1beb095cb43ac25fa3280d1bc0dd4",
  "test/ceo-hold-posture-review.test.ts": "dd13e49bfd9f47e2f51b1ff1ef8c4c3d052b159f4ebf6a91d0c4f2efe8beb436",
  "test/helpers/autoplan-artifact-recorder.ts": "fb8107c00959338dad777a28db0e4f9f473b19017d8d166d1a7bac22a8c052b3",
  "test/helpers/plan-review-board-feedback.ts": "777431138c42063865bdb98034026a53f140dfd9aaa094c184d3e2021bb3fb92",
  "test/plan-review-board-feedback.test.ts": "71b99992162a2a5599a9d1d4f5b125d17ff5df8948d2b4b4f921278f2469fa80"
};
for (const [file, expected] of Object.entries(pins)) {
 const actual = new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex');
 if (actual !== expected) throw new Error('Mirrored input changed: ' + file);
}
writeFileSync('windows-focused-pins.json', JSON.stringify({bun: Bun.version, pins},null,2));
console.log('Mirrored source hashes match for ' + Object.keys(pins).length + ' repair files');
