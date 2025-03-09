const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

const wss = {
  user: new WebSocket.Server({ noServer: true }),
  government: new WebSocket.Server({ noServer: true }),
  ngo: new WebSocket.Server({ noServer: true })
};

const activeRequests = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

server.on('upgrade', (request, socket, head) => {
  const pathname = request.url;
  
  if(pathname === '/ws/user') {
    wss.user.handleUpgrade(request, socket, head, (ws) => {
      wss.user.emit('connection', ws, request);
    });
  } else if(pathname === '/ws/government') {
    wss.government.handleUpgrade(request, socket, head, (ws) => {
      wss.government.emit('connection', ws, request);
    });
  } else if(pathname === '/ws/ngo') {
    wss.ngo.handleUpgrade(request, socket, head, (ws) => {
      wss.ngo.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.government.on('connection', (ws) => {
  console.log('Government connected');
  
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    
    if (data.type === 'verify_prediction') {
      // Broadcast to users
      broadcastToRole('user', { 
        type: 'disaster_alert',
        content: `VERIFIED ${data.disaster.toUpperCase()} ALERT!`,
        guidelines: data.guidelines.user,
        timestamp: new Date().toISOString()
      });
      
      // Broadcast to NGOs
      broadcastToRole('ngo', { 
        type: 'disaster_alert', 
        content: `OFFICIAL ${data.disaster.toUpperCase()} NOTIFICATION`,
        guidelines: data.guidelines.ngo,
        timestamp: new Date().toISOString()
      });

      // Send confirmation to government
      ws.send(JSON.stringify({ 
        type: 'alert_sent',
        content: `Alert broadcasted with guidelines`
      }));
    }
  });
});

// User WebSocket handler
wss.user.on('connection', (ws) => {
  console.log('User connected');
  ws.userId = uuidv4();

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    
    if (data.type === 'sos_request') {
      const requestId = uuidv4();
      activeRequests.set(requestId, {
        userWs: ws,
        status: 'pending',
        ...data,
        requestId: requestId
      });
      
      // Broadcast to NGO
      broadcastToRole('ngo', {
        type: 'sos_request',
        requestId: requestId,
        location: data.location,
        timestamp: new Date().toISOString()
      });
    }
  });
});

// NGO WebSocket handler
wss.ngo.on('connection', (ws) => {
  console.log('NGO connected');
  // Send existing requests on connection
  activeRequests.forEach((request, requestId) => {
    if(request.status === 'pending') {
      ws.send(JSON.stringify({
        type: 'sos_request',
        ...request
      }));
    }
  });
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    
    // Add this missing handler for accept_sos
    if (data.type === 'accept_sos') {
      const request = activeRequests.get(data.requestId);
      if (request && request.status === 'pending') {
        // Update request status
        activeRequests.set(data.requestId, {
          ...request,
          status: 'accepted',
          responder: data.responder,
          acceptedAt: new Date().toISOString()
        });

        // Notify user
        request.userWs.send(JSON.stringify({
          type: 'sos_accepted',
          requestId: data.requestId,
          responder: data.responder
        }));

        // Update NGO dashboards
        broadcastToRole('ngo', {
          type: 'request_updated',
          requestId: data.requestId,
          status: 'accepted',
          location: request.location,
          timestamp: request.timestamp,
          responder: data.responder,
          acceptedAt: new Date().toISOString()
        });
      }
    }
    else if (data.type === 'mark_rescued') {  // Remove duplicate handler
      const request = activeRequests.get(data.requestId);
      if (request) {
        // Notify user
        request.userWs.send(JSON.stringify({
          type: 'rescued_notification',
          requestId: data.requestId
        }));

        // Update NGO dashboards
        broadcastToRole('ngo', {
          type: 'request_updated',
          requestId: data.requestId,
          status: 'rescued',
          location: request.location
        });

        // Remove from active requests
        activeRequests.delete(data.requestId);

        // Log to government
        broadcastToRole('government', {
          type: 'rescue_log',
          location: request.location,
          timestamp: new Date().toISOString()
        });
      }
    }
    else if (data.type === 'add_resource') {
      // Broadcast to all users
      broadcastToRole('user', {
        type: 'resource_update',
        resource: data.resource
      });

      // Confirm to NGO
      broadcastToRole('ngo', {
        type: 'resource_added',
        resource: data.resource
      });
    }
  });
});

// Helper function to broadcast messages
function broadcastToRole(role, message) {
  wss[role].clients.forEach(client => {
    if(client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Start server
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});