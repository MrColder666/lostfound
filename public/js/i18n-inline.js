// public/js/i18n-inline.js —— 纯英文词典（v1.6.2：ZH 块已删除）；所有用户可见文案走 t()
export const t = (k) => EN[k] ?? k;

const EN = {
  pin_label: 'PIN (4 digits)', pin_ph: '4 digits', k_pin_ph: '4-digit PIN',
  pin_hint: 'First time? Choose a 4-digit PIN and remember it — you will need it every time.',
  k_pin_label: 'Your PIN (4 digits)', k_pin_hint: 'First time? Choose a 4-digit PIN and remember it.',
  pickup_by_label: 'Pick up by', claim_reserved_badge: 'RESERVED',
  offline_flushed: 'Sent {n} offline report(s) — thank you!',
  err_PIN_FORMAT: 'PIN must be exactly 4 digits.', err_PIN_INCORRECT: 'Wrong PIN — try again, or ask staff to reset it.',
  err_TOO_MANY_PIN: 'Too many wrong PIN attempts — please wait a bit.',
  err_TOO_MANY_ACTIVE: 'You already have 3 reserved items — collect them first.',
  err_TOO_MANY_TODAY: 'Daily claim limit reached — try again tomorrow.',
  err_IDENTITY_NAME_MISMATCH: 'This student ID is registered under a different name — ask staff to fix it.',
  err_NAME_MISMATCH: 'Name does not match our records.', err_IDENTITY_NOT_FOUND: 'Student ID is not registered yet.',
  err_CLAIM_NOT_FOUND: 'Claim not found.', err_CLAIM_EXPIRED: 'This claim has expired.',
  err_TOO_MANY_ATTEMPTS: 'Too many attempts — try again later.', err_NEED_2FA: 'Two-factor verification required.',
  k_toast_pin_format: 'PIN must be 4 digits', k_toast_pin_wrong: 'Wrong PIN', k_toast_pin_many: 'Too many wrong PINs — wait a bit',
  k_toast_claim_many: 'You have too many reserved items — collect them first', k_toast_claim_today: 'Daily claim limit reached — try again tomorrow',
  brand_sub: 'Lost & Found',
  
  shop_chip: 'Shop', shop_title: 'Rewards shop',
  shop_sub: 'Spend the points you earned from returns. Staff hand out the items — an order stays Pending until it is handed over.',
  shop_balance: 'Balance',
  shop_returns: 'Returns',
  shop_check: 'Check balance',
  shop_redeem: 'Redeem',
  shop_sold_out: 'Sold out',
  shop_stock_left: 'left',
  shop_need_more: 'Need',
  shop_my_orders: 'My orders',
  shop_no_orders: 'No orders yet',
  shop_order_title: 'Redemption order',
  shop_order_pending: 'Pending',
  shop_order_collect: 'Show this at the L&F desk to collect the item.',
  
  shop_empty: 'No rewards on the shelf yet — check back soon.',
  
  
  tab_home: 'Board', tab_report: '＋ Report', 
  loading: 'Loading…',
  
  
  back_home: 'Back to board',
   
  error_generic: 'Something went wrong, try again later',
  
  status_registered: 'Awaiting drop',
  status_in_stock: 'In stock',
  status_claim_pending: 'Being claimed',
  status_pending: 'Freeze period',
  status_ready: 'Ready for pickup',
  status_returned: 'Returned',
  status_voided: 'Voided',
  status_expired: 'Expired',
  cat_all: 'All', cat_electronics: 'Electronics', cat_card: 'Cards', cat_clothing: 'Clothing', cat_book: 'Books', cat_other: 'Other',
  tier_high: 'High value',
  stat_total: 'On display',
  stat_high: 'High value',
  stat_cats: 'Categories',
  stat_note: 'Audited hourly',
  empty_home: 'Nothing found yet — check back soon!',
  home_aside_title: 'My points',
  home_aside_hint: 'Enter 7-digit student ID',
  home_aside_btn: 'Look up',
  
  finder_label: 'Registered by',
  found_at_label: 'Intake date',
  slot_label: 'Slot',
  report_title: 'Report a found item',
  report_step1: 'Step 1 · Photo (optional)',
  report_step2: 'Step 2 · Describe the item',
  report_step3: 'Step 3 · Identity & verify Q&A',
  
  
  
  
  f_category: 'Category *',
  f_location: 'Found at *',
  
  
  
  
  f_student_id: 'Your student ID * (7 digits)',
  f_name: 'Your name *',
  f_class: 'Your class *',
  report_submit: 'Generate drop voucher',
  report_offline_note: 'Offline: saved to the outbox queue, will auto-submit when back online',
  err_BAD_STUDENT_ID: 'Student ID must be 7 digits',
  err_MISSING_FIELDS: 'Some required fields are missing',
  err_NOT_IMAGE: 'The photo is not a valid image',
  err_TOO_LARGE: 'Photo exceeds 1MB, please retake',
  claim_title: 'Item details & claim',
  claim_q_title: 'Verification',
  claim_answer_label: 'Answer the verify question *',
  
  claim_submit: 'Submit claim',
  
  claim_auto: 'Claim approved',
  claim_auto_hint: 'Item reserved — collect it at the L&F desk with your student ID and name',
  claim_pending_note: 'Entered the 1-hour freeze: if nobody else applies it is approved automatically — then collect it at the service desk with your student ID and name.',
  claim_review_note: 'Needs manual review (wrong answer / high value / competing claims). Once approved, collect it at the service desk with your student ID and name.',
  claim_ready_note: 'This item has been claimed and is ready for pickup.',
  
  err_ITEM_NOT_CLAIMABLE: 'Item not found or not claimable',
  err_NOT_FOUND: 'Record not found',
  
  points_id_label: 'Student ID (7 digits)',
  
  points_expand: 'Show details (name required)',
  points_name_label: 'Name used at registration',
  points_not_found: 'Student ID not found',
  points_forbidden: 'Name mismatch — details hidden',
  
  
  points_ledger_title: 'Points ledger',
  points_ledger_empty: 'No point records yet',
  
  reason_claim_reward: 'Return reward', reason_tip_in: 'Tip received', reason_tip_out: 'Tip sent', reason_redeem: 'Redemption', reason_adjust: 'Admin adjust',
  redeem_status_pending: 'Pending', redeem_status_fulfilled: 'Fulfilled', redeem_status_cancelled: 'Cancelled',
  mall_cost: 'pts',
  
  
  
  
  
  
  err_INSUFFICIENT_POINTS: 'Not enough points',
  err_OUT_OF_STOCK: 'Out of stock',
  err_REWARD_NOT_FOUND: 'Reward ID not found',
  // —— Kiosk service desk ——
  k_offline: 'Network unavailable — please try again later',
  k_desk_title: 'Lost & Found · Service Desk',
  k_found_b: 'I found something', k_found_s: 'Found something · photo check-in, about 1 min',
  k_lost_b: 'I lost something', k_lost_s: 'Lost something · browse the board, verify on site',
  k_how_h: 'How it works',
  k_step1: 'Found something → register here and the system assigns a numbered slot',
  k_step2: 'Place the item in the slot — it goes live on the board automatically',
  k_step3: 'The owner collects it at the kiosk with their student ID; the finder earns points',
  k_thanks: 'Thank you for turning things in 🙏',
  k_back: '← Back',  k_pickup_title: 'Pickup handout',
  
   
  k_report_title: 'Register a found item',
  k_cam_hint_ok: 'Tap “Take photo” to capture the item',
  k_cam_hint_bad: 'Camera unavailable — please grant camera permission and retry',
  k_shot: '📷 Take photo', k_shot_again: '📷 Retake', k_retake: 'Retake',
  k_next: 'Next →', k_prev: '← Back',
  k_what: 'What is it?', k_color_label: 'Main colour (builds the title automatically)', k_where: 'Where did you find it?',
  k_verify_label: 'A detail only the owner would know (optional · a hint when claiming, never shown publicly)',
  k_verify_ph: 'e.g. a name written inside / there is still a pen in it',
  k_verify_q_std: 'Describe a detail only the owner would know',
  k_your_sid: 'Your student ID', k_sid_ph: '7 digits',
  k_name: 'Name', k_class: 'Class', k_class_ph: 'e.g. 7(3)',
  k_points_hint: 'Points go to this student ID · credited only after a successful pickup',
  k_submit: 'Submit registration',
  k_selected: 'Selected', k_sum_empty: 'Nothing selected yet',
  k_photo_note_h: 'Photos are used for matching and the public board only',
  k_photo_note: 'The private detail is only compared during claim verification and never appears on the board.',
  k_confirm_title: 'Checked in', k_confirm_msg: 'Registered — please place it in the slot',
  k_slot: 'Slot', k_done_btn: 'I have placed it → Done', k_home: 'Back to start',
  k_find_title: 'I lost something', k_find_pick: '← Pick your item on the left',
  k_find_empty: 'Nothing on the board right now — check back soon',
  k_find_chosen: 'Your item', k_find_verify_h: 'Verify: answer the detail only the owner knows',
  k_find_verify_q: 'The registered verify question is — “', k_find_verify_q_end: '”',
  k_find_q_default: 'describe a private detail of the item',
  k_answer_ph: 'Your answer', k_identity: 'Your student ID / name / class', k_claim_submit: 'Submit claim',
   
  
  k_evidence_shot: '📷 Photo evidence', k_cancel: 'Cancel',
  k_done_title: 'Done', k_done_default: 'All done',
  k_pick_info_h: 'Claim verified',
  k_pickup_out: 'Confirm handout · photo evidence', k_pickup_out_note: 'After handout, points are credited to the finder automatically',
  k_sum_photo_yes: '📷 Photo captured', k_sum_photo_no: '📷 No photo',
  k_sum_cat: 'Category: ', k_sum_none: '—', k_sum_loc: 'Location: ',
  k_sum_verify_yes: 'Verify detail: filled', k_sum_verify_no: 'Verify detail: empty', k_sum_sid: 'ID: ',
  k_col_black: 'Black', k_col_white: 'White', k_col_blue: 'Blue', k_col_red: 'Red',
  k_col_green: 'Green', k_col_yellow: 'Yellow', k_col_pink: 'Pink', k_col_multi: 'Multicolour',
  k_loc_library: 'Library', k_loc_cafeteria: 'Cafeteria', k_loc_gym: 'Gym', k_loc_field: 'Playground',
  k_loc_hallway: 'Hallway', k_loc_classroom: 'Classroom', k_loc_restroom: 'Restrooms', k_loc_gate: 'Main Gate',
  
  
  
  k_toast_cam_not_ready: 'Camera not ready', k_toast_capture_fail: 'Capture failed, please retry',
  k_toast_photo_saved: 'Photo saved ✓',
  k_toast_bad_sid: 'Student ID should be 7 digits', k_toast_reg_fail: 'Registration failed, please retry',
  k_toast_full_admin: 'Lockers are full — please contact staff', 
  k_toast_fill: 'Please complete the verify answer and identity fields',
  k_toast_not_claimable: 'This item cannot be claimed right now', k_toast_claim_fail: 'Submission failed, please retry',
  k_toast_pickup_expired: 'Pickup code expired — please apply again', 
  k_toast_already: 'This claim was already handed out', k_toast_fulfill_fail: 'Handout failed, please retry',
  k_toast_no_cam: 'Camera unavailable — cannot capture evidence', k_toast_photo_big: 'Photo too large',
  k_claim_received: 'Verified — please confirm the handout',
  
  
   
  k_done_stored: 'Checked in — thank you!',
  k_done_stored_sub: 'The item is now on the board — points are credited once it is claimed and picked up',
  k_done_handed: 'Handed over — please take your item',
  k_points_capped: ' (monthly cap reached, partially credited)',
  k_points_capped_note: 'The finder has reached the monthly points cap — nothing credited this time',
  k_pickup_cta: 'Already approved? Collect it with your student ID + PIN →',
  k_pick_id_label: 'Your student ID and name',
  k_pick_lookup: 'Find my item',
  k_pick_lookup_hint: 'Items approved for you appear on the right.',
  k_pick_start: 'Enter your details to find your item',
  k_pick_found: 'Ready for you',
  k_pick_ready: 'Ready to collect',
  k_pick_wait: 'In review / freeze period',
  k_pick_expired: 'Expired — please ask the staff',
  k_pick_none: 'Nothing waiting for this student ID and name.',
  k_toast_need_name: 'Please enter your name',
  k_toast_name_mismatch: 'Name does not match this student ID',
  k_toast_lookup_fail: 'Lookup failed, please retry',
  
  k_kiosk_desc: 'Registered at the service desk',
  k_pts_awarded: 'Finder awarded +', k_pts_awarded_suf: ' points',
  k_name_ph: 'Name',
  gnav_board: 'Board', gnav_report: 'Report', 
  hero_kicker: 'Campus Lost & Found',
  hero_title: 'Lost something? Someone may have handed it in already.',
  hero_sub: 'The campus lost & found board — register what you find, claim what you lost, and earn points for every return.',
  cta_browse: 'I lost something',
  hero_note_report: 'Found something? Register it on your phone, or at the L&F kiosk.',
  wx_banner: 'WeChat may limit this page — tap ⋯ (top right) and choose "Open in Browser" for the full experience.',
  report_f_title: 'Item name', report_f_cat: 'Category', report_f_loc: 'Where you found it',
  report_f_desc: 'Short description (optional)', report_f_verify: 'A detail only the owner would know (optional · a hint for claiming)',
  report_f_sid: 'Your student ID', report_f_name: 'Name', report_f_class: 'Class',
  report_done_title: 'Registered · place it in the slot', report_done_hint: 'Put the item in the numbered slot above — it is already on the board.',
  report_done_foot: 'Once it is claimed, points are credited to your student ID automatically.', report_done_back: 'Back to the board',
  report_failed: 'Registration failed, please try again', err_bad_student_id: 'Student ID must be 7 digits',
  how_h: 'How it works',
  how1_t: 'Find & register', how1_d: 'Found a phone, a card, a water bottle? Snap a photo at the L&F kiosk — the system assigns a numbered locker slot.',
  how2_t: 'Match & verify', how2_d: 'The item goes live on the board. The owner collects it at the kiosk with their student ID.',
  how3_t: 'Return & earn', how3_d: 'The handout completes on the spot; the finder earns points to spend in the rewards shop.',
  board_h: 'On the board now'
};
