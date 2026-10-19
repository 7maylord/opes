import { UnauthorizedException } from '@nestjs/common';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';

describe('SessionController', () => {
  it('returns the user for a valid bearer token', async () => {
    const resolveUser = jest.fn(() =>
      Promise.resolve({
        id: 'user-1',
        email: 'owner@example.com',
        displayName: 'Owner',
      }),
    );
    const sessions = {
      resolveUser,
    } as unknown as SessionService;
    const controller = new SessionController(sessions);

    await expect(controller.getSession('Bearer token-1')).resolves.toEqual({
      id: 'user-1',
      email: 'owner@example.com',
      displayName: 'Owner',
    });
    expect(resolveUser).toHaveBeenCalledWith('token-1');
  });

  it('rejects missing bearer tokens', async () => {
    const resolveUser = jest.fn();
    const sessions = {
      resolveUser,
    } as unknown as SessionService;
    const controller = new SessionController(sessions);

    await expect(controller.getSession(undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it('rejects invalid sessions', async () => {
    const sessions = {
      resolveUser: jest.fn(() => Promise.resolve(null)),
    } as unknown as SessionService;
    const controller = new SessionController(sessions);

    await expect(controller.getSession('Bearer missing')).rejects.toThrow(
      'Session is invalid or expired',
    );
  });

  it('revokes bearer sessions', async () => {
    const revoke = jest.fn(() => Promise.resolve());
    const controller = new SessionController({
      revoke,
    } as unknown as SessionService);

    await expect(controller.revokeSession('Bearer token-1')).resolves.toEqual({
      revoked: true,
    });
    expect(revoke).toHaveBeenCalledWith('token-1');
  });

  it('rejects revoke without a bearer token', async () => {
    const revoke = jest.fn();
    const controller = new SessionController({
      revoke,
    } as unknown as SessionService);

    await expect(controller.revokeSession(undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(revoke).not.toHaveBeenCalled();
  });
});
