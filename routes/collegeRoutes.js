const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

const { uploadAndParsePDF, getAdminData, clearCache, deleteCollege, bulkDeleteColleges, cleanDuplicates, addCollege, editCollege, bulkAddColleges } = require('../controllers/collegeController');
const { getPredictions, getDropdownOptions } = require('../controllers/predictController');

router.post('/upload-pdf', upload.single('pdf'), uploadAndParsePDF);
router.get('/admin-search', getAdminData);
router.post('/clear-cache', clearCache);
router.delete('/delete/:id', deleteCollege);
router.post('/bulk-delete', bulkDeleteColleges);
router.post('/clean-duplicates', cleanDuplicates);

router.post('/add', addCollege);
router.put('/edit/:id', editCollege);
// 🌟 NAYA ROUTE: CSV Bulk Add ke liye
router.post('/bulk-add', bulkAddColleges);

router.post('/predict', getPredictions);
router.post('/dropdown', getDropdownOptions); 

module.exports = router;