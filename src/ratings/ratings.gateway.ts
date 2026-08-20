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

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/ratings',
})
export class RatingsGateway
  implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RatingsGateway.name);

  handleConnection(client: Socket) {
    this.logger.debug(`Client connected to ratings WS: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client disconnected from ratings WS: ${client.id}`);
  }

  @SubscribeMessage('join-room')
  async handleJoinRoom(
    @MessageBody() data: { userId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = `user:${data.userId}`;
    await client.join(room);
    this.logger.debug(`Socket ${client.id} joined ratings room ${room}`);
    return { joined: true };
  }

  emitNotification(userId: string, notification: any): void {
    const room = `user:${userId}`;
    if (this.server) {
      this.server.to(room).emit('notification:new', notification);
      this.logger.log(`Emitted notification:new to room ${room}`);
    }
  }

  emitRatingUpdated(userId: string, payload: any): void {
    const room = `user:${userId}`;
    if (this.server) {
      this.server.to(room).emit('rating:updated', payload);
      this.logger.log(`Emitted rating:updated to room ${room}`);
    }
  }
}
