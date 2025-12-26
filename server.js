// ============================================
// WhatsApp API Server with SSE Support
// For Supabase with NEW publishable keys
// ============================================

// Load environment variables from .env file
require('dotenv').config();

// Import required libraries
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// Create Express app
const app = express();

// Set port from .env or default to 8000
const PORT = process.env.PORT || 8000;

// ============================================
// SSE CLIENT MANAGEMENT
// ============================================
// Store all connected SSE clients
const sseClients = new Map(); // sessionId -> Set of response objects

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({
    origin: ['https://bbq-chat-if.onrender.com/', 'http://localhost:3000', 'https://figitallabsllp.retool.com/embedded/public/957b75c3-769a-4404-9d19-251c31994676', 'http://localhost:5173'],
    credentials: true
}));

// Parse JSON requests
app.use(express.json());

// ============================================
// SUPABASE SETUP
// ============================================

// Check if credentials are provided
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('❌ ERROR: Missing Supabase credentials in .env file!');
    console.log('Please add:');
    console.log('SUPABASE_URL=https://your-project.supabase.co');
    console.log('SUPABASE_KEY=your-publishable-key');
    console.log('\nFind these in Supabase Dashboard → Settings → API');
    process.exit(1);
}

console.log('🔧 Initializing Supabase connection...');
console.log('📋 URL:', process.env.SUPABASE_URL);
console.log('🔑 Key starts with:', process.env.SUPABASE_KEY.substring(0, 20) + '...');

// Initialize Supabase client with NEW publishable keys
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY,
    {
        auth: {
            persistSession: false
        }
    }
);

console.log('✅ Supabase client initialized successfully!');

// ============================================
// SSE HELPER FUNCTIONS
// ============================================

// Add a new SSE client for a specific session
function addSSEClient(sessionId, res) {
    if (!sseClients.has(sessionId)) {
        sseClients.set(sessionId, new Set());
    }
    sseClients.get(sessionId).add(res);
    console.log(`✅ SSE client connected for session: ${sessionId}. Total clients for this session: ${sseClients.get(sessionId).size}`);
}

// Remove SSE client
function removeSSEClient(sessionId, res) {
    const clients = sseClients.get(sessionId);
    if (clients) {
        clients.delete(res);
        if (clients.size === 0) {
            sseClients.delete(sessionId);
        }
        console.log(`👋 SSE client disconnected from session: ${sessionId}`);
    }
}

// Broadcast message to all clients listening to a specific session
function broadcastToSession(sessionId, message) {
    const clients = sseClients.get(sessionId);
    if (clients && clients.size > 0) {
        console.log(`📢 Broadcasting to ${clients.size} client(s) in session: ${sessionId}`);
        const data = JSON.stringify(message);
        
        clients.forEach(client => {
            try {
                client.write(`data: ${data}\n\n`);
            } catch (error) {
                console.error('Error writing to SSE client:', error.message);
                removeSSEClient(sessionId, client);
            }
        });
    } else {
        console.log(`ℹ️ No clients connected for session: ${sessionId}`);
    }
}

// ============================================
// API ENDPOINTS
// ============================================

// 1. ROOT ENDPOINT - Health check
app.get('/', (req, res) => {
    res.json({
        message: 'WhatsApp Message API with SSE is running!',
        status: 'healthy',
        version: '2.0.0',
        sse_enabled: true,
        connected_sessions: Array.from(sseClients.keys()),
        endpoints: {
            health: 'GET /',
            testDB: 'GET /api/test',
            getMessages: 'GET /api/messages/:sessionId',
            sendMessage: 'POST /api/messages',
            getMessage: 'GET /api/message/:messageId',
            sseStream: 'GET /api/sse/:sessionId',
            webhook: 'POST /webhook/supabase'
        }
    });
});

// 2. TEST DATABASE CONNECTION
app.get('/api/test', async (req, res) => {
    console.log('📊 Testing database connection...');
    
    try {
        const { count, error } = await supabase
            .from('whatsapp_messages')
            .select('*', { count: 'exact', head: true });
        
        if (error) {
            console.error('❌ Database error:', error.message);
            throw error;
        }
        
        console.log('✅ Database connected! Total messages:', count || 0);
        
        res.json({
            success: true,
            message: 'Database connected successfully!',
            total_messages: count || 0,
            supabase_url: process.env.SUPABASE_URL,
            key_type: 'publishable_key',
            sse_active_sessions: Array.from(sseClients.keys()),
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            hint: 'Check your Supabase credentials and internet connection'
        });
    }
});

// 3. SSE ENDPOINT - Real-time updates for a session
app.get('/api/sse/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    console.log(`🌊 SSE connection request for session: ${sessionId}`);
    
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', session_id: sessionId })}\n\n`);
    
    // Add this client to the session
    addSSEClient(sessionId, res);
    
    // Send heartbeat every 30 seconds to keep connection alive
    const heartbeat = setInterval(() => {
        try {
            res.write(`:heartbeat\n\n`);
        } catch (error) {
            clearInterval(heartbeat);
            removeSSEClient(sessionId, res);
        }
    }, 30000);
    
    // Clean up on disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        removeSSEClient(sessionId, res);
        console.log(`🔌 SSE connection closed for session: ${sessionId}`);
    });
});

// 4. GET ALL MESSAGES FOR A SESSION
app.get('/api/messages/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    console.log(`📥 Getting messages for session: "${sessionId}"`);
    
    try {
        const { data, error } = await supabase
            .from('whatsapp_messages')
            .select('*')
            .eq('session_id', sessionId)
            .order('timestamp', { ascending: true });
        
        if (error) {
            console.error(`❌ Database error for session ${sessionId}:`, error.message);
            throw error;
        }
        
        console.log(`✅ Found ${data.length} messages for session "${sessionId}"`);
        
        res.json({
            success: true,
            session_id: sessionId,
            count: data.length,
            messages: data,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error(`❌ Server error for session ${sessionId}:`, error.message);
        res.status(500).json({
            success: false,
            session_id: sessionId,
            error: error.message,
            messages: []
        });
    }
});

// 5. SEND A NEW MESSAGE
app.post('/api/messages', async (req, res) => {
    console.log('📤 Received new message request');
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    try {
        const { session_id, sender_id, message_text, recipient_id = 'bot' } = req.body;
        
        // Validate required fields
        if (!session_id) {
            throw new Error('Missing required field: session_id');
        }
        if (!sender_id) {
            throw new Error('Missing required field: sender_id');
        }
        if (!message_text || message_text.trim() === '') {
            throw new Error('Missing required field: message_text');
        }
        
        console.log(`💬 New message from ${sender_id} to ${recipient_id}: "${message_text.substring(0, 50)}${message_text.length > 50 ? '...' : ''}"`);
        
        const { data, error } = await supabase
            .from('whatsapp_messages')
            .insert([{
                session_id: session_id,
                sender_id: sender_id,
                recipient_id: recipient_id,
                message_text: message_text,
                message_type: 'text',
                status: 'sent',
                timestamp: new Date().toISOString()
            }])
            .select()
            .single();
        
        if (error) {
            console.error('❌ Failed to insert message:', error.message);
            throw error;
        }
        
        console.log(`✅ Message saved! ID: ${data.w_msg_id}`);
        
        // Broadcast to SSE clients (in case webhook is slow or fails)
        broadcastToSession(session_id, {
            type: 'NEW_MESSAGE',
            message: data
        });
        
        res.json({
            success: true,
            message: 'Message sent successfully!',
            w_msg_id: data.w_msg_id,
            session_id: data.session_id,
            sender_id: data.sender_id,
            timestamp: data.timestamp,
            data: data
        });
        
    } catch (error) {
        console.error('❌ Failed to send message:', error.message);
        
        if (error.message.includes('Missing required field')) {
            res.status(400).json({
                success: false,
                error: error.message,
                required_fields: ['session_id', 'sender_id', 'message_text'],
                example: {
                    session_id: 'chat-session-123',
                    sender_id: 'user1',
                    message_text: 'Hello there!',
                    recipient_id: 'user2'
                }
            });
        } else {
            res.status(500).json({
                success: false,
                error: error.message,
                hint: 'Check if Supabase table exists and has correct permissions'
            });
        }
    }
});

// 6. GET A SPECIFIC MESSAGE BY ID
app.get('/api/message/:messageId', async (req, res) => {
    const messageId = req.params.messageId;
    console.log(`🔍 Looking for message with ID: ${messageId}`);
    
    try {
        const { data, error } = await supabase
            .from('whatsapp_messages')
            .select('*')
            .eq('w_msg_id', messageId)
            .single();
        
        if (error) {
            if (error.code === 'PGRST116') {
                console.log(`❌ Message not found: ${messageId}`);
                throw new Error('Message not found');
            }
            throw error;
        }
        
        console.log(`✅ Found message: ${data.sender_id} → ${data.recipient_id}: "${data.message_text.substring(0, 30)}..."`);
        
        res.json({
            success: true,
            message: data
        });
        
    } catch (error) {
        console.error(`❌ Error getting message ${messageId}:`, error.message);
        
        if (error.message === 'Message not found') {
            res.status(404).json({
                success: false,
                error: 'Message not found',
                messageId: messageId
            });
        } else {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
});

// 7. GET ALL SESSIONS
app.get('/api/sessions', async (req, res) => {
    console.log('📋 Getting all unique sessions...');
    
    try {
        const { data, error } = await supabase
            .from('whatsapp_messages')
            .select('session_id')
            .order('session_id');
        
        if (error) throw error;
        
        const uniqueSessions = [...new Set(data.map(item => item.session_id))];
        
        console.log(`✅ Found ${uniqueSessions.length} unique sessions`);
        
        res.json({
            success: true,
            count: uniqueSessions.length,
            sessions: uniqueSessions,
            active_sse_sessions: Array.from(sseClients.keys())
        });
        
    } catch (error) {
        console.error('❌ Error getting sessions:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// WEBHOOK ENDPOINT FOR SUPABASE
// ============================================

app.post('/webhook/supabase', async (req, res) => {
    console.log('🎣 Webhook received from Supabase');
    
    try {
        const { type, table, record, old_record } = req.body;
        console.log(`📦 Type: ${type}, Table: ${table}`);
        console.log('📄 Record:', JSON.stringify(record, null, 2));
        
        // Immediately respond to Supabase
        res.json({ success: true, message: 'Webhook received' });
        
        // Process INSERT events to whatsapp_messages table
        if (table === 'whatsapp_messages' && type === 'INSERT') {
            console.log(`✅ New message inserted for session: ${record.session_id}`);
            
            // Broadcast to all SSE clients listening to this session
            broadcastToSession(record.session_id, {
                type: 'NEW_MESSAGE',
                message: record
            });
            
            console.log(`📢 Broadcast complete for session: ${record.session_id}`);
        }
        
    } catch (error) {
        console.error('❌ Error processing webhook:', error.message);
    }
});

// ============================================
// ERROR HANDLING FOR INVALID ROUTES
// ============================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found',
        requested_url: req.originalUrl,
        available_endpoints: [
            'GET  /',
            'GET  /api/test',
            'GET  /api/sse/:sessionId',
            'GET  /api/messages/:sessionId',
            'POST /api/messages',
            'GET  /api/message/:messageId',
            'GET  /api/sessions',
            'POST /webhook/supabase'
        ]
    });
});

// ============================================
// START THE SERVER
// ============================================

app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 WHATSAPP MESSAGE API WITH SSE STARTED');
    console.log('='.repeat(50));
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`🌐 Network: http://YOUR_IP:${PORT}`);
    console.log(`🔗 Supabase: ${process.env.SUPABASE_URL}`);
    console.log(`📝 Key type: Publishable key`);
    console.log(`🌊 SSE Support: ENABLED`);
    console.log('='.repeat(50));
    console.log('\n📌 AVAILABLE ENDPOINTS:');
    console.log('   GET  /                     - Health check');
    console.log('   GET  /api/test            - Test database connection');
    console.log('   GET  /api/sse/:sessionId  - SSE stream for real-time updates');
    console.log('   GET  /api/messages/:id    - Get messages for a session');
    console.log('   POST /api/messages        - Send new message');
    console.log('   GET  /api/message/:id     - Get specific message');
    console.log('   GET  /api/sessions        - Get all chat sessions');
    console.log('   POST /webhook/supabase    - Webhook for database changes');
    console.log('\n⚡ Press Ctrl+C to stop the server');
    console.log('='.repeat(50) + '\n');
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down server gracefully...');
    // Close all SSE connections
    sseClients.forEach((clients, sessionId) => {
        clients.forEach(client => {
            try {
                client.end();
            } catch (e) {}
        });
    });
    sseClients.clear();
    process.exit(0);
});