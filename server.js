const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

// WebSocket servers for different roles
const wss = {
  user: new WebSocket.Server({ noServer: true }),
  government: new WebSocket.Server({ noServer: true }),
  ngo: new WebSocket.Server({ noServer: true })
};

// Store active SOS requests
const activeRequests = new Map();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Handle WebSocket upgrades
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

// Government WebSocket handler
wss.government.on('connection', (ws) => {
  console.log('Government connected');
  
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    
    if (data.type === 'disaster_alert') {
      // Broadcast alert to users and NGOs
      broadcastToRole('user', { 
        type: 'disaster_alert', 
        content: data.content,
        timestamp: new Date().toISOString()
      });
      
      broadcastToRole('ngo', { 
        type: 'disaster_alert', 
        content: data.content,
        timestamp: new Date().toISOString()
      });

      // Confirm alert sent
      ws.send(JSON.stringify({ 
        type: 'alert_sent', 
        content: data.content 
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
  
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    
    if (data.type === 'accept_sos') {
      const request = activeRequests.get(data.requestId);
      if (request && request.status === 'pending') {
        // Update request status
        activeRequests.set(data.requestId, {
          ...request,
          status: 'accepted',
          responder: data.responder
        });
        
        // Notify user
        request.userWs.send(JSON.stringify({
          type: 'sos_accepted',
          requestId: data.requestId,
          responder: data.responder
        }));

        // Update NGO UI
        broadcastToRole('ngo', {
          type: 'request_updated',
          requestId: data.requestId,
          status: 'accepted'
        });
      }
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