-- =====================================================================
-- TeleCRM demo data - run this directly in MySQL Workbench
-- Safe to run more than once (skips rows that already exist).
--
-- Logins created:
--   sakshi@deeraj.com / Sakshi@123
--   priya@deeraj.com  / Priya@123
-- (Admin login stays whatever is in your backend .env)
-- =====================================================================

USE telecrm;

-- ---------- 1. Telecallers (passwords are bcrypt hashes) ----------
INSERT INTO users (name, email, phone, password, role)
SELECT 'Sakshi', 'sakshi@deeraj.com', '9000000001',
       '$2a$10$80RJAoM1XB9VStivf/B.B.APn.Ifrt8H4dfGJYSYRm2ZZcYeNRtai', 'telecaller'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'sakshi@deeraj.com');

INSERT INTO users (name, email, phone, password, role)
SELECT 'Priya', 'priya@deeraj.com', '9000000002',
       '$2a$10$3H.BbqkdqjfS.NNJhjU/b.DmGWUXlkZ9Cg7GnbvfnwdYpXZRm404a', 'telecaller'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'priya@deeraj.com');

-- ---------- 2. Leads (from the Excel sheet) ----------
-- @s = Sakshi's id, @p = Priya's id
SET @s := (SELECT id FROM users WHERE email = 'sakshi@deeraj.com');
SET @p := (SELECT id FROM users WHERE email = 'priya@deeraj.com');

INSERT INTO leads (name, primary_phone, assigned_to, first_calling_date, second_calling_date,
                   call_category, quote_sent, order_booked, whatsapp_sent_date, whatsapp_category,
                   calling_remark, next_call_date, priority, source)
SELECT * FROM (
  SELECT 'Mahesh' n,'9963462553' ph, @s a, CURDATE()-INTERVAL 2 DAY f, NULL s2,
         'NOT INTERESTED' c,'No' q,'No' o, CURDATE()-INTERVAL 1 DAY w,'DECOR' wc,
         'no not required' r, NULL nx,'cold' pr,'Demo data' src
  UNION ALL SELECT 'Anil Kumar','9390778917',@p, CURDATE()-INTERVAL 3 DAY, CURDATE()-INTERVAL 2 DAY,
         'FOLLOW UP','No','No', CURDATE()-INTERVAL 2 DAY,'DECOR',
         'if required he will call us', CURDATE()+INTERVAL 2 DAY,'warm','Demo data'
  UNION ALL SELECT 'Venkat','8886102345',@s, CURDATE()-INTERVAL 4 DAY, NULL,
         'NOT INTERESTED','No','No', CURDATE()-INTERVAL 3 DAY,'DECOR','no thank you', NULL,'cold','Demo data'
  UNION ALL SELECT 'Saikiran','7799588333',@p, CURDATE()-INTERVAL 5 DAY, NULL,
         'NOT INTERESTED','No','No', CURDATE()-INTERVAL 4 DAY,'DECOR','noo', NULL,'cold','Demo data'
  UNION ALL SELECT 'Sravan Mukka','7498574166',@s, CURDATE()-INTERVAL 6 DAY, NULL,
         'NOT INTERESTED','No','No', CURDATE()-INTERVAL 5 DAY,'DECOR','no not intrested', NULL,'cold','Demo data'
  UNION ALL SELECT 'Durga Sameera Puli','9573205311',@p, CURDATE()-INTERVAL 2 DAY, CURDATE()-INTERVAL 1 DAY,
         'INTERESTED','Yes','No', CURDATE()-INTERVAL 1 DAY,'DECOR',
         'she wants designs (guntur 4bhk) (sent)', CURDATE()+INTERVAL 1 DAY,'hot','Demo data'
  UNION ALL SELECT 'Sri Kumar','9676931544',@s, CURDATE()-INTERVAL 3 DAY, NULL,
         'NOT INTERESTED','No','No', CURDATE()-INTERVAL 2 DAY,'DECOR','no not required', NULL,'cold','Demo data'
  UNION ALL SELECT 'Goutham Sreevani','9502238371',@p, CURDATE()-INTERVAL 2 DAY, NULL,
         'NOT ANSWERED','','', CURDATE()-INTERVAL 1 DAY,'DECOR','', CURDATE()+INTERVAL 1 DAY,'warm','Demo data'
  UNION ALL SELECT 'Shivani Reddy','9108279165',@s, CURDATE()-INTERVAL 2 DAY, NULL,
         'NOT ANSWERED','','', CURDATE()-INTERVAL 1 DAY,'DECOR','', CURDATE()+INTERVAL 1 DAY,'warm','Demo data'
  UNION ALL SELECT 'Hanumanulu Tamlurka','7972258540',@p, CURDATE()-INTERVAL 4 DAY, NULL,
         'NOT INTERESTED','No','No', CURDATE()-INTERVAL 3 DAY,'DECOR','no not required', NULL,'cold','Demo data'
  UNION ALL SELECT 'Prabhakar Reddy','8008877676',@s, CURDATE()-INTERVAL 5 DAY, NULL,
         'NOT INTERESTED','No','No', CURDATE()-INTERVAL 4 DAY,'DECOR','not required', NULL,'cold','Demo data'
  UNION ALL SELECT 'Ravi','9402592291',@p, CURDATE()-INTERVAL 6 DAY, NULL,
         'NOT INTERESTED','No','No', CURDATE()-INTERVAL 5 DAY,'DECOR','noo', NULL,'cold','Demo data'
  UNION ALL SELECT 'Anjali Chandra Sekhar','9849343909',@s, CURDATE()-INTERVAL 3 DAY, NULL,
         'NOT INTERESTED','No','No', CURDATE()-INTERVAL 2 DAY,'DECOR','no thank you', NULL,'cold','Demo data'
  UNION ALL SELECT 'Santosh Kumar','9966746633',@p, CURDATE()-INTERVAL 2 DAY, NULL,
         'NOT INTERESTED','No','No', CURDATE()-INTERVAL 1 DAY,'DECOR','not required', NULL,'cold','Demo data'
  UNION ALL SELECT 'Vijay Kumar','9849322982',@s, CURDATE()-INTERVAL 4 DAY, NULL,
         'NOT INTERESTED','No','No', CURDATE()-INTERVAL 3 DAY,'DECOR','no requirements', NULL,'cold','Demo data'
  UNION ALL SELECT 'Saritha','9703761009',@p, CURDATE()-INTERVAL 5 DAY, NULL,
         'NOT INTERESTED','No','No', CURDATE()-INTERVAL 4 DAY,'DECOR','not intrested', NULL,'cold','Demo data'
  UNION ALL SELECT 'Venkat Rao','9700050678',@s, CURDATE()-INTERVAL 3 DAY, CURDATE()-INTERVAL 2 DAY,
         'FOLLOW UP','No','No', CURDATE()-INTERVAL 2 DAY,'DECOR',
         'if required they wil call us', CURDATE()+INTERVAL 2 DAY,'warm','Demo data'
  UNION ALL SELECT 'Lakshmi Devi','9876543210',@p, CURDATE()-INTERVAL 2 DAY, CURDATE()-INTERVAL 1 DAY,
         'INTERESTED','Yes','Yes', CURDATE()-INTERVAL 1 DAY,'DECOR',
         'wants 3bhk interior quote, hyderabad', CURDATE()+INTERVAL 1 DAY,'hot','Demo data'
  UNION ALL SELECT 'Ramesh Goud','9812345670',NULL, NULL, NULL,'','','', NULL,'','', NULL,'none','Demo data'
  UNION ALL SELECT 'Sunitha Rani','9823456781',NULL, NULL, NULL,'','','', NULL,'','', NULL,'none','Demo data'
) AS t
WHERE NOT EXISTS (SELECT 1 FROM leads WHERE leads.primary_phone = t.ph);

-- ---------- 3. Call logs (so "Calls per day" shows history) ----------
INSERT INTO call_logs (lead_id, user_id, remark, category, log_date)
SELECT l.id, l.assigned_to, IF(l.calling_remark = '', 'called', l.calling_remark), l.call_category,
       TIMESTAMP(l.first_calling_date, '10:30:00')
FROM leads l
WHERE l.source = 'Demo data' AND l.assigned_to IS NOT NULL AND l.call_category <> ''
  AND l.first_calling_date IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM call_logs c WHERE c.lead_id = l.id);

INSERT INTO call_logs (lead_id, user_id, remark, category, log_date)
SELECT l.id, l.assigned_to, CONCAT('2nd call: ', IF(l.calling_remark = '', 'followed up', l.calling_remark)),
       l.call_category, TIMESTAMP(l.second_calling_date, '15:00:00')
FROM leads l
WHERE l.source = 'Demo data' AND l.assigned_to IS NOT NULL AND l.second_calling_date IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM call_logs c WHERE c.lead_id = l.id AND c.remark LIKE '2nd call:%');

-- ---------- 4. Verify ----------
SELECT (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM leads) AS leads,
       (SELECT COUNT(*) FROM call_logs) AS call_logs;
