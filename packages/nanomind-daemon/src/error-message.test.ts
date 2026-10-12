import { describe, it } from 'node:test';
import assert from 'node:assert';
import { errorMessage } from './error-message.ts';

/** The error Node raises when a connection is refused on every address of a host. */
function refusedOnEveryAddress(): AggregateError {
  const err = new AggregateError(
    [new Error('connect ECONNREFUSED ::1:443'), new Error('connect ECONNREFUSED 127.0.0.1:443')],
    '',
  );
  return Object.assign(err, { code: 'ECONNREFUSED' });
}

describe('errorMessage()', () => {
  it('returns the message of an error that has one', () => {
    assert.strictEqual(errorMessage(new Error('download x: HTTP 404')), 'download x: HTTP 404');
  });

  it('returns the inner errors of an AggregateError whose message is empty', () => {
    assert.strictEqual(
      errorMessage(refusedOnEveryAddress()),
      'connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443',
    );
  });

  it('returns the code of an error with no message and no inner errors', () => {
    assert.strictEqual(errorMessage(Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' })), 'ECONNREFUSED');
  });

  it('returns the name when nothing else describes the error', () => {
    assert.strictEqual(errorMessage(new TypeError()), 'TypeError');
  });

  it('returns a value that is not an Error as text', () => {
    assert.strictEqual(errorMessage('socket closed'), 'socket closed');
  });
});
