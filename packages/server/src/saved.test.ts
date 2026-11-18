import { expect, test } from 'vitest';
import * as Y from 'yjs';
import { localChanges } from '../../bridge/src/saved.ts';
import { holds, TEXT } from './sync.ts';

test('the server is asked about exactly the inserts and deletes made here', () => {
  const server = new Y.Doc();
  server.getText(TEXT).insert(0, 'Hello world.\n');
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  const text = client.getText(TEXT);
  const changes = localChanges(client);
  const held = () => holds(server, Buffer.from(changes.question().saved, 'base64url'));
  const send = () =>
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client, Y.encodeStateVector(server)));

  // Nothing done here yet.
  expect(held()).toBe(true);

  text.insert(0, 'Oh. ');
  expect(held()).toBe(false);
  send();
  expect(held()).toBe(true);
  expect(changes.confirmed(changes.question().n)).toBe(true);

  // A delete adds nothing, so counting inserts would call it saved. It is not.
  const inserts = Y.encodeStateVector(client);
  text.delete(4, 6);
  expect(Y.encodeStateVector(client)).toEqual(inserts);
  expect(held()).toBe(false);
  send();
  expect(held()).toBe(true);
  expect(server.getText(TEXT).toString()).toBe('Oh. world.\n');

  // What arrives from other people is not this copy's to ask about.
  const asked = changes.question();
  server.getText(TEXT).insert(0, 'Someone else. ');
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server, Y.encodeStateVector(client)), 'remote');
  expect(changes.question().n).toBe(asked.n);
  expect(held()).toBe(true);

  // A yes to an earlier question does not cover what was typed after it.
  text.insert(0, 'Later. ');
  expect(changes.confirmed(asked.n)).toBe(false);
  expect(held()).toBe(false);

  // Deleting part of what someone else wrote, and part of one's own unsent text.
  text.delete(0, 12);
  expect(held()).toBe(false);
  send();
  expect(held()).toBe(true);
  expect(changes.confirmed(changes.question().n)).toBe(true);
  expect(server.getText(TEXT).toString()).toBe(text.toString());
});
