// SwiftPay STK Push API Endpoint
// Uses SwiftPay's Daraja credentials, but routes payments to user's Till

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// SwiftPay's master M-Pesa credentials (never exposed to users)
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_DEFAULT_TILL = process.env.MPESA_TILL_NUMBER;
const CALLBACK_BASE_URL = process.env.MPESA_CALLBACK_URL;

async function getAccessToken() {
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');

    const response = await fetch('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
        method: 'GET',
        headers: {
            'Authorization': `Basic ${auth}`
        }
    });

    const data = await response.json();
    return data.access_token;
}

function generateTransactionId() {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `SWP_${timestamp}${random}`;
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    try {
        const { api_key, amount, phone, reference } = req.body;

        // Validate required fields
        if (!api_key) {
            return res.status(401).json({ success: false, message: 'API key is required' });
        }

        if (!amount || !phone) {
            return res.status(400).json({ success: false, message: 'Amount and phone are required' });
        }

        // Validate phone format
        const cleanPhone = phone.toString().replace(/\D/g, '');
        if (!/^254[0-9]{9}$/.test(cleanPhone)) {
            return res.status(400).json({ success: false, message: 'Invalid phone number format. Use 254XXXXXXXXX' });
        }

        // Validate amount
        const numAmount = parseInt(amount);
        if (numAmount < 1 || numAmount > 150000) {
            return res.status(400).json({ success: false, message: 'Amount must be between 1 and 150000' });
        }

        // Verify API key and get user
        const { data: apiKeyData, error: apiKeyError } = await supabase
            .from('api_keys')
            .select('*, profiles(*)')
            .eq('api_key', api_key)
            .eq('is_active', true)
            .single();

        if (apiKeyError || !apiKeyData) {
            return res.status(401).json({ success: false, message: 'Invalid API key' });
        }

        // Update last used
        await supabase
            .from('api_keys')
            .update({ last_used_at: new Date().toISOString() })
            .eq('id', apiKeyData.id);

        // Get user's default till number (or use SwiftPay's default)
        let tillNumber = MPESA_DEFAULT_TILL;

        const { data: userTill } = await supabase
            .from('tills')
            .select('till_number')
            .eq('user_id', apiKeyData.user_id)
            .eq('is_default', true)
            .eq('is_active', true)
            .single();

        if (userTill) {
            tillNumber = userTill.till_number;
        }

        // Get M-Pesa access token (always uses SwiftPay's credentials)
        const accessToken = await getAccessToken();
        if (!accessToken) {
            return res.status(500).json({ success: false, message: 'Failed to authenticate with M-Pesa' });
        }

        // Generate transaction ID and timestamp
        const transactionId = generateTransactionId();
        const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
        const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');

        // STK Push request - PartyB is the user's Till number
        const stkResponse = await fetch('https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({
                BusinessShortCode: MPESA_SHORTCODE,
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerBuyGoodsOnline',
                Amount: numAmount,
                PartyA: cleanPhone,
                PartyB: tillNumber,  // User's Till number - money goes here!
                PhoneNumber: cleanPhone,
                CallBackURL: `${CALLBACK_BASE_URL}/api/payments/callback`,
                AccountReference: reference || 'SwiftPay',
                TransactionDesc: 'Payment via SwiftPay'
            })
        });

        const stkData = await stkResponse.json();

        if (stkData.ResponseCode === '0') {
            // Save transaction to database
            await supabase
                .from('transactions')
                .insert({
                    user_id: apiKeyData.user_id,
                    api_key_id: apiKeyData.id,
                    transaction_id: transactionId,
                    checkout_request_id: stkData.CheckoutRequestID,
                    merchant_request_id: stkData.MerchantRequestID,
                    phone: cleanPhone,
                    amount: numAmount,
                    reference: reference || 'SwiftPay',
                    status: 'pending'
                });

            return res.status(200).json({
                success: true,
                transaction_id: transactionId,
                checkout_request_id: stkData.CheckoutRequestID,
                message: 'STK Push sent successfully'
            });
        } else {
            return res.status(400).json({
                success: false,
                message: stkData.errorMessage || stkData.ResponseDescription || 'STK Push failed'
            });
        }

    } catch (error) {
        console.error('STK Push error:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error: ' + (error.message || String(error)),
            stack: error.stack
        });
    }
}
