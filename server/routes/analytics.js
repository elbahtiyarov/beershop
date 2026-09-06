const express = require('express');
const pool = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireAdmin); // показатели видит только администратор

router.get('/summary', async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  try {
    const todayRes = await pool.query(`
      SELECT COALESCE(SUM(total), 0)::numeric AS revenue, COUNT(*)::int AS sales_count
      FROM receipts
      WHERE deleted_at IS NULL AND created_at::date = CURRENT_DATE
    `);
    const costRes = await pool.query(`
      SELECT COALESCE(SUM(ri.cost_price * ri.qty), 0)::numeric AS cost
      FROM receipt_items ri
      JOIN receipts r ON r.id = ri.receipt_id
      WHERE r.deleted_at IS NULL AND r.created_at::date = CURRENT_DATE
    `);
    const seriesRes = await pool.query(
      `
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
        COALESCE((
          SELECT SUM(total) FROM receipts r
          WHERE r.deleted_at IS NULL AND r.created_at::date = d::date
        ), 0)::numeric AS revenue
      FROM generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, interval '1 day') AS d
      ORDER BY d
      `,
      [days]
    );

    const revenue = Number(todayRes.rows[0].revenue);
    const salesCount = Number(todayRes.rows[0].sales_count);
    const cost = Number(costRes.rows[0].cost);

    res.json({
      today: {
        revenue,
        salesCount,
        avgCheck: salesCount > 0 ? revenue / salesCount : 0,
        cost,
        grossProfit: revenue - cost,
      },
      series: seriesRes.rows.map((r) => ({ date: r.day, revenue: Number(r.revenue) })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
