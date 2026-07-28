import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { SyncCompleteEventDto } from './dto/sync-complete-event.dto';

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/github-sync',
})
export class GithubSyncGateway
  implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(GithubSyncGateway.name);

  handleConnection(client: Socket) {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  /**
   * Client emits 'join-room' with { userId } after connecting.
   * We join the socket to a per-user room so we can target events precisely.
   */
  @SubscribeMessage('join-room')
  async handleJoinRoom(
    @MessageBody() data: { userId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = `user:${data.userId}`;
    await client.join(room);
    this.logger.debug(`Socket ${client.id} joined room ${room}`);
    return { joined: true };
  }

  /**
   * Called by the BullMQ processor after job completion or failure.
   * Emits the event to every socket in the user's room.
   */
  emitSyncComplete(userId: string, payload: SyncCompleteEventDto): void {
    console.log('🔥 [GATEWAY] emitSyncComplete() called for user:', userId);
    const room = `user:${userId}`;
    this.server.to(room).emit('github-sync:complete', payload);
    this.logger.log(
      `Emitted github-sync:complete to room ${room} — status: ${payload.status}`,
    );
  }
}
