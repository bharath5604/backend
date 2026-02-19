const express = require("express");

const router = express.Router();

const adminController =
require("../controllers/adminController");

const auth =
require("../middleware/authMiddleware");



router.get(
"/completed",
auth,
adminController.getCompletedTasks
);


router.get(
"/pending-payments",
auth,
adminController.getPendingPayments
);


router.put(
"/pay/:taskId",
auth,
adminController.payStudent
);



module.exports = router;
