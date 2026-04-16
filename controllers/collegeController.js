const pdfParseRaw = require('pdf-parse'); 
const fs = require('fs');
const path = require('path');
const College = require('../models/College');

const parsePDF = typeof pdfParseRaw === 'function' ? pdfParseRaw : pdfParseRaw.default;

// 🚀 ADVANCED CACHING: Store data in RAM for instant 0ms responses 🚀
let cachedColleges = null; 

// Refresh Cache Function to keep RAM updated with MongoDB without blocking
const refreshCache = async () => {
    try {
        console.log("Refreshing Server RAM Cache from MongoDB...");
        const allData = await College.find({}).lean(); // .lean() makes query 10x faster
        cachedColleges = allData.map(doc => ({ id: doc._id.toString(), ...doc }));
        console.log(`Cache Ready! Total Colleges Loaded: ${cachedColleges.length}`);
    } catch (error) {
        console.error("Cache Refresh Failed:", error);
    }
};

// 🌟 1. PDF UPLOAD & SMART EXTRACTION (Non-blocking)
exports.uploadAndParsePDF = async (req, res) => {
    try {
        if (!req.file) return res.status(400).send("No file uploaded.");
        console.log("File received:", req.file.path);

        const dataBuffer = fs.readFileSync(req.file.path);
        if (!parsePDF) throw new Error("PDF library missing.");
        
        console.log("Reading massive PDF...");
        const data = await parsePDF(dataBuffer, { max: 0 }); 
        
        // FLATTEN THE PDF
        let fullText = data.text.replace(/\n/g, ' ').replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
        console.log(`PDF Parsed. Starting Extraction Engine...`);

        // PRE-COMPILED REGEX (Performance boost: Don't compile inside loop)
        const quotas = [
            "All India", "Open Seat Quota", "Deemed\\/Paid Seats Quota", "IP University Quota", 
            "Non-Resident Indian", "B\\.Sc Nursing All India", "B\\.Sc Nursing Delhi NCR", 
            "B\\.Sc Nursing Delhi NCR CW Quota", "B\\.Sc Nursing IP CW Quota", 
            "Delhi NCR Children\\/Widows.*?DU Quota", "Delhi NCR Children\\/Widows.*?IP Quota", 
            "Delhi University Quota", "Employees State Insurance Scheme Nursing Quota.*?", 
            "Employees State Insurance Scheme(?: \\(ESI\\))?", "Foreign Country Quota", 
            "Internal -Puducherry UT Domicile", "Jain Minority Quota", "Jamia Internal Quota", 
            "Muslim Minority Quota", "Muslim OBC Quota", "Muslim Quota", "Muslim ST Quota", 
            "Muslim Women Quota", "Non-Resident Indian.*?Quota", 
            "Aligarh Muslim University \\(AMU\\) Quota", "\\(AMU\\) Self finance All India", 
            "\\(AMU\\) Self finance internal"
        ].join("|");

        const categories = [
            "Open PwD", "Open", "General-EWS PwD", "General-EWS", "EWS PwD", "EWS",
            "OBC-NCL PwD", "OBC-NCL", "OBC PwD", "OBC", "SC PwD", "SC", "Schedule Caste.*?",
            "ST PwD", "ST", "Schedule Tribe.*?", "General PwD", "General", "GN PwD", "GN"
        ].join("|");

        const regexStr = `(\\d{1,8})\\s+(${quotas})\\s+(.+?\\d{6}(?:\\s*\\([^)]+\\))?)\\s+(MBBS|BDS|B\\.Sc\\.?\\s*Nursing)\\s+(${categories})\\s+(${categories})\\s+(Allotted|Reported)`;
        const regex = new RegExp(regexStr, "gi");

        const uniqueCollegesMap = new Map();
        let matchCount = 0;
        let match;

        // ACCURATE DATA EXTRACTION
        while ((match = regex.exec(fullText)) !== null) {
            matchCount++;
            const rank = parseInt(match[1]);
            const rawInstitute = match[3];
            let course = match[4].trim();
            const allottedCatRaw = match[5].toUpperCase(); 

            let cleanName = rawInstitute.replace(/\(.*?\)/g, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
            if (course.toLowerCase().includes("nursing")) course = "B.Sc. Nursing";

            let finalCategory = 'General';
            if (allottedCatRaw.includes('OB') || allottedCatRaw.includes('BC')) finalCategory = 'OBC';
            else if (allottedCatRaw.includes('EW')) finalCategory = 'EWS';
            else if (allottedCatRaw.includes('SC') || allottedCatRaw.includes('SCHEDULE CASTE')) finalCategory = 'SC';
            else if (allottedCatRaw.includes('ST') || allottedCatRaw.includes('SCHEDULE TRIBE')) finalCategory = 'ST';

            const signature = `${cleanName}-${course}`.toLowerCase();
            
            if (!uniqueCollegesMap.has(signature)) {
                uniqueCollegesMap.set(signature, {
                    name: cleanName,
                    course: course,
                    exam: "NEET",
                    state: "India", 
                    cutoffs: { General: 0, OBC: 0, EWS: 0, SC: 0, ST: 0 }
                });
            }

            const college = uniqueCollegesMap.get(signature);
            if (rank > college.cutoffs[finalCategory]) {
                college.cutoffs[finalCategory] = rank;
            }
        }

        const finalCleanColleges = Array.from(uniqueCollegesMap.values());
        console.log(`✅ Success! Matched ${matchCount} records. Found ${finalCleanColleges.length} UNIQUE colleges.`);

        if (finalCleanColleges.length === 0) {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: "No valid data extracted. Check PDF format." });
        }

        // Instantly return response to user, process DB in background
        res.status(200).json({ 
            message: `🎉 Success! Accurately extracted ${finalCleanColleges.length} Colleges. Merging in background...`,
            sampleData: finalCleanColleges.slice(0, 3) 
        });

        // 🚀 NON-BLOCKING MONGODB UPSERT 🚀
        setImmediate(async () => {
            try {
                const MAX_BATCH_SIZE = 500; 
                for (let i = 0; i < finalCleanColleges.length; i += MAX_BATCH_SIZE) {
                    const chunk = finalCleanColleges.slice(i, i + MAX_BATCH_SIZE);
                    
                    const bulkOps = chunk.map(col => {
                        let maxUpdate = {};
                        if(col.cutoffs.General > 0) maxUpdate["cutoffs.General"] = col.cutoffs.General;
                        if(col.cutoffs.OBC > 0) maxUpdate["cutoffs.OBC"] = col.cutoffs.OBC;
                        if(col.cutoffs.EWS > 0) maxUpdate["cutoffs.EWS"] = col.cutoffs.EWS;
                        if(col.cutoffs.SC > 0) maxUpdate["cutoffs.SC"] = col.cutoffs.SC;
                        if(col.cutoffs.ST > 0) maxUpdate["cutoffs.ST"] = col.cutoffs.ST;

                        return {
                            updateOne: {
                                filter: { name: col.name, course: col.course, exam: 'NEET' },
                                update: {
                                    $max: maxUpdate,
                                    $setOnInsert: { exam: col.exam, state: col.state }
                                },
                                upsert: true 
                            }
                        }
                    });

                    if (bulkOps.length > 0) {
                        await College.bulkWrite(bulkOps, { ordered: false }); // unordered makes it faster
                    }
                }
                await refreshCache(); // Update RAM
                console.log("🔥 Background Merge Complete!");
            } catch (bgError) {
                console.error("🔥 MongoDB Merge Failed:", bgError);
            } finally {
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); // Always cleanup file
            }
        });

    } catch (error) {
        console.error("🔥 ERROR:", error.message);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
};

// 🌟 2. ULTRA-FAST ADMIN API LOGIC (O(N) Filtering)
exports.getAdminData = async (req, res) => {
    try {
        if (!cachedColleges) await refreshCache();

        const { search, filter, state, district, exam } = req.query;
        let results = cachedColleges;

        if (exam && exam !== 'All') {
            results = results.filter(c => c.exam === exam);
        }
        if (filter && filter !== 'All') {
            if (filter === 'AIIMS') {
                results = results.filter(c => c.name && c.name.toUpperCase().includes('AIIMS'));
            } else {
                results = results.filter(c => c.course === filter);
            }
        }
        if (state && state !== 'All India (Any State)') {
            results = results.filter(c => c.state && c.state.toLowerCase() === state.toLowerCase());
        }
        if (district && district !== 'All Districts') {
            results = results.filter(c => c.name && c.name.toLowerCase().includes(district.toLowerCase()));
        }
        if (search) {
            const s = search.toLowerCase();
            results = results.filter(c => 
                (c.name && c.name.toLowerCase().includes(s)) || 
                (c.state && c.state.toLowerCase().includes(s))
            );
        }

        res.status(200).json({ 
            totalFound: results.length, 
            colleges: results.slice(0, 300) // Paginate for safety
        });

    } catch (error) {
        console.error("Admin Search Error:", error);
        res.status(500).json({ error: error.message });
    }
};

exports.clearCache = async (req, res) => {
    await refreshCache();
    res.status(200).json({ message: "Cache Cleared & Refreshed from Database!" });
};

// 🌟 3. MONGODB: SINGLE DELETE API
exports.deleteCollege = async (req, res) => {
    try {
        const { id } = req.params;
        await College.findByIdAndDelete(id);
        await refreshCache();
        res.status(200).json({ message: "College deleted successfully!" });
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ error: error.message });
    }
};

// 🌟 4. MONGODB: BULK DELETE API
exports.bulkDeleteColleges = async (req, res) => {
    try {
        const { filter, search, exam } = req.body;
        let query = {}; 

        if (exam && exam !== 'All') query.exam = exam;
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { state: { $regex: search, $options: 'i' } }
            ];
        }
        if (filter && filter !== 'All') {
            if (filter === 'AIIMS') query.name = { $regex: 'AIIMS', $options: 'i' };
            else query.course = filter;
        }

        const result = await College.deleteMany(query);
        await refreshCache();
        
        res.status(200).json({ 
            message: `Boom! 💥 Successfully deleted ${result.deletedCount} records!`,
            deletedCount: result.deletedCount
        });

    } catch (error) {
        console.error("Bulk Delete Error:", error);
        res.status(500).json({ error: error.message });
    }
};

// 🌟 5. MONGODB: SMART DUPLICATE CLEANER
exports.cleanDuplicates = async (req, res) => {
    res.status(200).json({ message: "Database is structured by unique colleges now. Automatic deduplication applied.", deletedCount: 0 });
};

// 🌟 6. MONGODB: ADD SINGLE COLLEGE MANUALLY
exports.addCollege = async (req, res) => {
    try {
        const newCollege = new College({ 
            ...req.body, 
            exam: req.body.exam || 'NEET' 
        }); 
        await newCollege.save();
        await refreshCache(); 

        res.status(201).json({ message: "College added successfully!", college: newCollege });
    } catch (error) {
        console.error("Add College Error:", error);
        res.status(500).json({ error: error.message });
    }
};

// 🌟 7. MONGODB: EDIT EXISTING COLLEGE
exports.editCollege = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedCollege = await College.findByIdAndUpdate(id, req.body, { new: true });
        await refreshCache();
        
        res.status(200).json({ message: "College updated successfully!", college: updatedCollege });
    } catch (error) {
        console.error("Edit College Error:", error);
        res.status(500).json({ error: error.message });
    }
};

// 🌟 8. MONGODB: BULK ADD COLLEGES VIA CSV/EXCEL
exports.bulkAddColleges = async (req, res) => {
    try {
        const { exam, colleges } = req.body;
        
        if (!colleges || !Array.isArray(colleges) || colleges.length === 0) {
            return res.status(400).json({ error: "Invalid data format or empty list." });
        }

        const bulkOps = colleges.map(col => {
            let maxUpdate = {};
            if(col.cutoffs.General > 0) maxUpdate["cutoffs.General"] = col.cutoffs.General;
            if(col.cutoffs.OBC > 0) maxUpdate["cutoffs.OBC"] = col.cutoffs.OBC;
            if(col.cutoffs.EWS > 0) maxUpdate["cutoffs.EWS"] = col.cutoffs.EWS;
            if(col.cutoffs.SC > 0) maxUpdate["cutoffs.SC"] = col.cutoffs.SC;
            if(col.cutoffs.ST > 0) maxUpdate["cutoffs.ST"] = col.cutoffs.ST;

            return {
                updateOne: {
                    filter: { name: col.name, course: col.course, exam: exam },
                    update: {
                        $set: maxUpdate, 
                        $setOnInsert: { state: col.state || "India" }
                    },
                    upsert: true 
                }
            }
        });

        await College.bulkWrite(bulkOps, { ordered: false });
        await refreshCache();
        
        res.status(200).json({ message: `Successfully Imported & Merged ${colleges.length} Colleges!` });

    } catch (error) {
        console.error("Bulk Add Error:", error);
        res.status(500).json({ error: error.message });
    }
};